import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathToFileURL } from "node:url";

import { HOST_PACKAGE_NAME } from "../src/adapter/host-package.js";
import { captureInfo, installRunnerCapture, resetRunnerCapture } from "../src/adapter/runner-capture.js";
import { REPO_ROOT } from "./helpers/host.js";

afterEach(() => {
	resetRunnerCapture();
});

describe("runner capture", () => {
	it("fails closed with a clear reason when an injected host class has no UI seam", async () => {
		const result = await installRunnerCapture({
			importer: async (specifier) => {
				assert.equal(specifier, HOST_PACKAGE_NAME);
				return { ExtensionRunner: class ExtensionRunner {} };
			},
		});

		assert.equal(result.ok, false);
		assert.match(result.error, /does not expose ExtensionRunner\.setUIContext/);
		assert.equal(captureInfo().patchInstalled, false);
		assert.equal(captureInfo().captures, 0);
		assert.equal(captureInfo().source, "injected");
	});

	it("fails closed on the first existing candidate without importing another runner graph", async () => {
		const fakeRoot = mkdtempSync(join(tmpdir(), "pi-capture-single-candidate-"));
		const marker = join(fakeRoot, "imports.log");
		const bundleCandidate = join(fakeRoot, "dist", "bundle", "index.js");
		const distCandidate = join(fakeRoot, "dist", "index.js");
		const runtimeEntry = join(fakeRoot, "dist", "bundle", "cli.js");
		const nodeModules = join(REPO_ROOT, "node_modules");
		const scopeDir = join(nodeModules, "@earendil-works");
		const barePackage = join(scopeDir, "pi-coding-agent");
		const hadNodeModules = existsSync(nodeModules);
		const hadScopeDir = existsSync(scopeDir);
		assert.equal(existsSync(barePackage), false, "the test must own the temporary bare-specifier package slot");
		try {
			mkdirSync(join(fakeRoot, "dist", "bundle"), { recursive: true });
			writeFileSync(join(fakeRoot, "package.json"), JSON.stringify({ name: HOST_PACKAGE_NAME, version: "0.85.1", type: "module" }));
			writeFileSync(runtimeEntry, "");
			writeFileSync(marker, "");
			writeFileSync(
				bundleCandidate,
				`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "bundle\\n");\nexport class ExtensionRunner {}\n`,
			);
			writeFileSync(
				distCandidate,
				`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "dist\\n");\nexport class ExtensionRunner { setUIContext() {} }\n`,
			);

			// Make the bare package import observable without touching the installed host.
			// The production path must stop at the invalid first candidate, so this package
			// must never be evaluated either.
			mkdirSync(barePackage, { recursive: true });
			writeFileSync(
				join(barePackage, "package.json"),
				JSON.stringify({ name: HOST_PACKAGE_NAME, version: "0.85.1", type: "module", exports: "./index.js" }),
			);
			writeFileSync(
				join(barePackage, "index.js"),
				`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "specifier\\n");\nexport class ExtensionRunner { setUIContext() {} }\n`,
			);

			const result = await installRunnerCapture({
				env: { PI_BROWSER_UI_PACKAGE_ROOT: fakeRoot },
				argv: ["node", runtimeEntry],
			});
			assert.equal(result.ok, false);
			assert.match(result.error, /does not expose ExtensionRunner\.prototype\.setUIContext/);
			assert.equal(readFileSync(marker, "utf8"), "bundle\n", "only the first existing candidate may be evaluated");
			assert.equal(captureInfo().source, "bundle");
			assert.equal(captureInfo().usedSource, null);
			assert.equal(captureInfo().attempts, 1);
			assert.match(captureInfo().candidateUrl, /dist\/bundle\/index\.js$/);
		} finally {
			rmSync(fakeRoot, { recursive: true, force: true });
			rmSync(barePackage, { recursive: true, force: true });
			if (!hadScopeDir && existsSync(scopeDir) && readdirSync(scopeDir).length === 0) {
				rmSync(scopeDir, { recursive: true, force: true });
			}
			if (!hadNodeModules && existsSync(nodeModules) && readdirSync(nodeModules).length === 0) {
				rmSync(nodeModules, { recursive: true, force: true });
			}
		}
	});

	it("uses the realpathed symlink target to prioritize the running bundle candidate", async () => {
		const fakeRoot = mkdtempSync(join(tmpdir(), "pi-capture-realpath-bundle-"));
		const runtimeEntry = join(fakeRoot, "bin", "pi.js");
		const realEntry = join(fakeRoot, "dist", "bundle", "cli.js");
		const bundleCandidate = join(fakeRoot, "dist", "bundle", "index.js");
		const distCandidate = join(fakeRoot, "dist", "index.js");
		try {
			mkdirSync(join(fakeRoot, "bin"), { recursive: true });
			mkdirSync(join(fakeRoot, "dist", "bundle"), { recursive: true });
			writeFileSync(join(fakeRoot, "package.json"), JSON.stringify({ name: HOST_PACKAGE_NAME, version: "0.85.1", type: "module" }));
			writeFileSync(runtimeEntry, "");
			writeFileSync(realEntry, "");
			writeFileSync(
				bundleCandidate,
				`export const identity = "bundle";\nexport class ExtensionRunner { setUIContext() { return identity; } }\n`,
			);
			writeFileSync(
				distCandidate,
				`export const identity = "dist";\nexport class ExtensionRunner { setUIContext() { return identity; } }\n`,
			);

			const realpathCalls = [];
			const result = await installRunnerCapture({
				env: { PI_BROWSER_UI_PACKAGE_ROOT: fakeRoot },
				argv: ["node", runtimeEntry],
				realpath: (entry) => {
					realpathCalls.push(entry);
					return realEntry;
				},
			});
			assert.equal(result.ok, true);
			assert.deepEqual(realpathCalls, [runtimeEntry]);
			assert.equal(captureInfo().source, "bundle");
			assert.equal(captureInfo().usedSource, "bundle");
			assert.match(captureInfo().candidateUrl, /dist\/bundle\/index\.js$/);

			const bundle = await import(pathToFileURL(bundleCandidate).href);
			const dist = await import(pathToFileURL(distCandidate).href);
			assert.equal(bundle.identity, "bundle");
			assert.equal(dist.identity, "dist");
			assert.equal(new bundle.ExtensionRunner().setUIContext(), "bundle");
			assert.equal(captureInfo().captures, 1, "the bundle candidate class must be patched");
			assert.equal(new dist.ExtensionRunner().setUIContext(), "dist");
			assert.equal(captureInfo().captures, 1, "the dist candidate class must remain untouched");
		} finally {
			rmSync(fakeRoot, { recursive: true, force: true });
		}
	});

	it("falls back to the literal package specifier when no package root is resolvable", async () => {
		const fakeRoot = mkdtempSync(join(tmpdir(), "pi-capture-specifier-fallback-"));
		const marker = join(fakeRoot, "imports.log");
		const missingEntry = join(fakeRoot, "bin", "pi.js");
		const nodeModules = join(REPO_ROOT, "node_modules");
		const scopeDir = join(nodeModules, "@earendil-works");
		const barePackage = join(scopeDir, "pi-coding-agent");
		const hadNodeModules = existsSync(nodeModules);
		const hadScopeDir = existsSync(scopeDir);
		assert.equal(existsSync(barePackage), false, "the test must own the temporary bare-specifier package slot");
		try {
			mkdirSync(join(fakeRoot, "bin"), { recursive: true });
			writeFileSync(missingEntry, "");
			writeFileSync(marker, "");
			mkdirSync(barePackage, { recursive: true });
			writeFileSync(
				join(barePackage, "package.json"),
				JSON.stringify({ name: HOST_PACKAGE_NAME, version: "0.85.1", type: "module", exports: "./index.js" }),
			);
			writeFileSync(
				join(barePackage, "index.js"),
				`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "specifier\\n");\nexport class ExtensionRunner { setUIContext() {} }\n`,
			);

			const result = await installRunnerCapture({ env: {}, argv: ["node", missingEntry] });
			assert.equal(result.ok, true);
			assert.equal(captureInfo().source, "specifier");
			assert.equal(captureInfo().usedSource, "specifier");
			assert.equal(captureInfo().candidateUrl, null);
			assert.equal(captureInfo().attempts, 1);
			assert.equal(readFileSync(marker, "utf8"), "specifier\n", "the fallback specifier must be evaluated exactly once");
		} finally {
			rmSync(fakeRoot, { recursive: true, force: true });
			rmSync(barePackage, { recursive: true, force: true });
			if (!hadScopeDir && existsSync(scopeDir) && readdirSync(scopeDir).length === 0) {
				rmSync(scopeDir, { recursive: true, force: true });
			}
			if (!hadNodeModules && existsSync(nodeModules) && readdirSync(nodeModules).length === 0) {
				rmSync(nodeModules, { recursive: true, force: true });
			}
		}
	});

	it("reports both package-root and bare-specifier shape failures", async () => {
		const fakeRoot = mkdtempSync(join(tmpdir(), "pi-capture-specifier-shape-"));
		const missingEntry = join(fakeRoot, "bin", "pi.js");
		const nodeModules = join(REPO_ROOT, "node_modules");
		const scopeDir = join(nodeModules, "@earendil-works");
		const barePackage = join(scopeDir, "pi-coding-agent");
		const hadNodeModules = existsSync(nodeModules);
		const hadScopeDir = existsSync(scopeDir);
		assert.equal(existsSync(barePackage), false, "the test must own the temporary bare-specifier package slot");
		try {
			mkdirSync(join(fakeRoot, "bin"), { recursive: true });
			writeFileSync(missingEntry, "");
			mkdirSync(barePackage, { recursive: true });
			writeFileSync(
				join(barePackage, "package.json"),
				JSON.stringify({ name: HOST_PACKAGE_NAME, version: "0.85.1", type: "module", exports: "./index.js" }),
			);
			writeFileSync(join(barePackage, "index.js"), "export class ExtensionRunner {}\n");

			const runnerCaptureUrl = pathToFileURL(join(REPO_ROOT, "src", "adapter", "runner-capture.js")).href;
			const childSource = `
				const { captureInfo, installRunnerCapture } = await import(${JSON.stringify(runnerCaptureUrl)});
				const result = await installRunnerCapture({ env: {}, argv: ["node", ${JSON.stringify(missingEntry)}] });
				console.log(JSON.stringify({ result, info: captureInfo() }));
			`;
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});
			assert.equal(child.status, 0, child.stderr);
			const childResult = JSON.parse(child.stdout.trim());
			assert.equal(childResult.result.ok, false);
			assert.match(childResult.result.error, /host package resolution failed for runner capture/);
			assert.match(childResult.result.error, /bare specifier .*loaded but does not expose ExtensionRunner\.prototype\.setUIContext/);
			assert.equal(childResult.info.source, "specifier");
			assert.equal(childResult.info.usedSource, null);
			assert.equal(childResult.info.candidateUrl, null);
			assert.equal(childResult.info.attempts, 1);
		} finally {
			rmSync(fakeRoot, { recursive: true, force: true });
			rmSync(barePackage, { recursive: true, force: true });
			if (!hadScopeDir && existsSync(scopeDir) && readdirSync(scopeDir).length === 0) {
				rmSync(scopeDir, { recursive: true, force: true });
			}
			if (!hadNodeModules && existsSync(nodeModules) && readdirSync(nodeModules).length === 0) {
				rmSync(nodeModules, { recursive: true, force: true });
			}
		}
	});

	it("reuses the injected prototype hook without stacking another wrapper", async () => {
		class ExtensionRunner {
			setUIContext() {
				return "host";
			}
		}
		const importer = async () => ({ ExtensionRunner });
		const first = await installRunnerCapture({ importer });
		const second = await installRunnerCapture({ importer });
		assert.equal(first.ok, true);
		assert.equal(first.alreadyInstalled, false);
		assert.equal(second.ok, true);
		assert.equal(second.alreadyInstalled, true);
		assert.equal(captureInfo().source, "injected");

		const runner = new ExtensionRunner();
		assert.equal(runner.setUIContext("context"), "host");
		assert.equal(captureInfo().captures, 1);
		assert.equal(captureInfo().source, "injected");
	});
});
