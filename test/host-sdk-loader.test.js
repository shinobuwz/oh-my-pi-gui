/**
 * SDK host resolution and import: explicit env overrides, global npm locations,
 * `npm root -g` fallback, fail-closed explicit overrides, and export-shape validation.
 * None of these cases requires an installed Pi package or a network call: every path is
 * a temporary fixture root and the `npm root -g` runner is injected.
 *
 * The final block keeps the repository-level portability guards (no hardcoded personal
 * installation paths, no import of the bundled CLI entry) that were migrated out of the
 * removed `test/host-package.test.js` when the private-seam route was deleted.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import {
	globalPackageRoots,
	HOST_PACKAGE_NAME,
	loadHostSdk,
	missingSdkExports,
	PACKAGE_ROOT_ENV,
	resolveSdkEntry,
	SDK_ENTRY_SEGMENTS,
	SDK_PATH_ENV,
} from "../src/host/sdk-loader.js";

const FAKE_SDK_FIXTURE = resolve(fileURLToPath(new URL("./fixtures/fake-sdk.js", import.meta.url)));
const INCOMPLETE_FIXTURE = resolve(fileURLToPath(new URL("./fixtures/fake-sdk-incomplete.js", import.meta.url)));
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_SEGMENTS = HOST_PACKAGE_NAME.split("/");

const tempDirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-gui-sdk-"));
	tempDirs.push(dir);
	return dir;
}

/** Create `<root>/@earendil-works/pi-coding-agent/dist/index.js` and return its path. */
function writePackageEntry(root) {
	const distDir = join(root, ...PACKAGE_SEGMENTS, "dist");
	mkdirSync(distDir, { recursive: true });
	const entry = join(distDir, ...SDK_ENTRY_SEGMENTS.slice(-1));
	writeFileSync(entry, "export const createAgentSession = async () => ({});\nexport const SessionManager = { create: () => ({}) };\n");
	writeFileSync(join(root, ...PACKAGE_SEGMENTS, "package.json"), JSON.stringify({ name: HOST_PACKAGE_NAME, version: "0.0.0-fixture" }));
	return entry;
}

after(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("globalPackageRoots", () => {
	it("orders the Windows APPDATA root first and keeps POSIX and ~/.npm-global roots", () => {
		const roots = globalPackageRoots({ env: { APPDATA: "C:\\Users\\probe\\AppData\\Roaming" }, platform: "win32", homedir: "/home/probe" });
		assert.equal(roots[0], join("C:\\Users\\probe\\AppData\\Roaming", "npm", "node_modules"));
		assert.deepEqual(roots.slice(1), [
			"/usr/local/lib/node_modules",
			"/usr/lib/node_modules",
			join("/home/probe", ".npm-global", "lib", "node_modules"),
		]);
		assert.equal(new Set(roots).size, roots.length, "candidate roots must not be duplicated");
	});

	it("omits the APPDATA root on non-Windows platforms and when APPDATA is missing", () => {
		const roots = globalPackageRoots({ env: { APPDATA: "C:\\Users\\probe\\AppData\\Roaming" }, platform: "linux", homedir: "/home/probe" });
		assert.equal(roots.includes(join("C:\\Users\\probe\\AppData\\Roaming", "npm", "node_modules")), false);
	});
});

describe("resolveSdkEntry", () => {
	it("fails closed for an explicit PI_GUI_SDK_PATH without trying global fallbacks", () => {
		const tmp = tempDir();
		const validEntry = writePackageEntry(join(tmp, "global"));
		let npmRootCalls = 0;
		const result = resolveSdkEntry({
			env: { [SDK_PATH_ENV]: join(tmp, "missing-sdk") },
			platform: "linux",
			homedir: join(tmp, "home"),
			execFileSync: () => {
				npmRootCalls += 1;
				return `${join(tmp, "global")}\n`;
			},
		});
		assert.match(result.error, /PI_GUI_SDK_PATH=.*refusing to fall back/);
		assert.equal(npmRootCalls, 0, "an explicit override failure must not consult other installations");
		assert.ok(validEntry.length > 0);
	});

	it("fails closed for an explicit PI_GUI_PACKAGE_ROOT that has no SDK entry", () => {
		const tmp = tempDir();
		const result = resolveSdkEntry({
			env: { [PACKAGE_ROOT_ENV]: join(tmp, "not-a-pi-root") },
			platform: "linux",
			homedir: join(tmp, "home"),
			execFileSync: () => {
				throw new Error("npm root -g must not run");
			},
		});
		assert.match(result.error, /PI_GUI_PACKAGE_ROOT=.*refusing to fall back/);
	});

	it("resolves an explicit PI_GUI_SDK_PATH module file before everything else", () => {
		const tmp = tempDir();
		const entry = writePackageEntry(join(tmp, "installed"));
		const result = resolveSdkEntry({
			env: { [SDK_PATH_ENV]: entry, [PACKAGE_ROOT_ENV]: join(tmp, "other") },
			platform: "linux",
			homedir: join(tmp, "home"),
			execFileSync: () => `${join(tmp, "installed")}\n`,
		});
		assert.deepEqual(result, { entryPath: resolve(entry), packageRoot: null, source: `env:${SDK_PATH_ENV}`, attempts: [] });
	});

	it("accepts a package root as PI_GUI_SDK_PATH", () => {
		const tmp = tempDir();
		const entry = writePackageEntry(join(tmp, "package-root"));
		const root = join(tmp, "package-root", ...PACKAGE_SEGMENTS);
		const result = resolveSdkEntry({
			env: { [SDK_PATH_ENV]: root },
			platform: "linux",
			homedir: join(tmp, "home"),
		});
		assert.equal(result.entryPath, resolve(entry));
		assert.equal(result.packageRoot, resolve(root));
		assert.equal(result.source, `env:${SDK_PATH_ENV}`);
	});

	it("resolves an explicit PI_GUI_PACKAGE_ROOT through dist/index.js", () => {
		const tmp = tempDir();
		const packageRoot = join(tmp, "pi-root");
		const entry = join(packageRoot, ...SDK_ENTRY_SEGMENTS);
		mkdirSync(join(packageRoot, "dist"), { recursive: true });
		writeFileSync(entry, "export {};\n");
		const result = resolveSdkEntry({ env: { [PACKAGE_ROOT_ENV]: packageRoot }, platform: "linux", homedir: join(tmp, "home") });
		assert.equal(result.entryPath, resolve(entry));
		assert.equal(result.source, `env:${PACKAGE_ROOT_ENV}`);
	});

	it("resolves the Windows APPDATA global npm root without running npm", () => {
		const tmp = tempDir();
		const entry = writePackageEntry(join(tmp, "AppData", "Roaming", "npm", "node_modules"));
		const result = resolveSdkEntry({
			env: { APPDATA: join(tmp, "AppData", "Roaming") },
			platform: "win32",
			homedir: join(tmp, "home"),
			execFileSync: () => {
				throw new Error("npm root -g must not run when a global candidate exists");
			},
		});
		assert.equal(result.entryPath, resolve(entry));
		assert.match(result.source, /^global:/);
	});

	it("resolves ~/.npm-global/lib/node_modules on POSIX", () => {
		const tmp = tempDir();
		const entry = writePackageEntry(join(tmp, ".npm-global", "lib", "node_modules"));
		const result = resolveSdkEntry({
			env: {},
			platform: "linux",
			homedir: tmp,
			execFileSync: () => {
				throw new Error("npm root -g must not run when a global candidate exists");
			},
		});
		assert.equal(result.entryPath, resolve(entry));
		assert.equal(result.source, `global:${join(tmp, ".npm-global", "lib", "node_modules")}`);
	});

	it("falls back to the last line of `npm root -g` output", () => {
		const tmp = tempDir();
		const globalRoot = join(tmp, "npm-global");
		const entry = writePackageEntry(globalRoot);
		let calls = 0;
		const result = resolveSdkEntry({
			env: {},
			platform: "linux",
			homedir: join(tmp, "home"),
			execFileSync: (command, args) => {
				calls += 1;
				assert.equal(command, "npm");
				assert.deepEqual(args, ["root", "-g"]);
				return `noise line\r\n${globalRoot}\r\n`;
			},
		});
		assert.equal(calls, 1);
		assert.equal(result.entryPath, resolve(entry));
		assert.equal(result.source, `npm-root-g:${globalRoot}`);
		assert.deepEqual(result.attempts, [
			`global npm root /usr/local/lib/node_modules does not contain ${PACKAGE_SEGMENTS.join("/")}/${SDK_ENTRY_SEGMENTS.join("/")}`,
			`global npm root /usr/lib/node_modules does not contain ${PACKAGE_SEGMENTS.join("/")}/${SDK_ENTRY_SEGMENTS.join("/")}`,
			`global npm root ${join(tmp, "home", ".npm-global", "lib", "node_modules")} does not contain ${PACKAGE_SEGMENTS.join("/")}/${SDK_ENTRY_SEGMENTS.join("/")}`,
		]);
	});

	it("reports every failed attempt and both override variables when nothing is installed", () => {
		const tmp = tempDir();
		const result = resolveSdkEntry({
			env: {},
			platform: "linux",
			homedir: join(tmp, "home"),
			execFileSync: () => {
				throw Object.assign(new Error("npm is not on PATH"), { code: "ENOENT" });
			},
		});
		assert.match(result.error, new RegExp(SDK_PATH_ENV));
		assert.match(result.error, new RegExp(PACKAGE_ROOT_ENV));
		assert.equal(result.attempts.length, 4);
		assert.match(result.attempts.at(-1), /npm root -g.*failed: npm is not on PATH/);
	});

	it("reports a `npm root -g` result without the package", () => {
		const tmp = tempDir();
		const globalRoot = join(tmp, "npm-global");
		mkdirSync(globalRoot, { recursive: true });
		const result = resolveSdkEntry({
			env: {},
			platform: "linux",
			homedir: join(tmp, "home"),
			execFileSync: () => `${globalRoot}\n`,
		});
		assert.match(result.attempts.at(-1), /does not contain/);
		assert.match(result.error, /could not locate/);
	});
});

describe("loadHostSdk", () => {
	it("imports the fixture SDK through the absolute path of PI_GUI_SDK_PATH", async () => {
		const result = await loadHostSdk({ env: { [SDK_PATH_ENV]: FAKE_SDK_FIXTURE } });
		assert.equal(result.error, undefined);
		assert.equal(result.entryPath, FAKE_SDK_FIXTURE);
		assert.equal(result.source, `env:${SDK_PATH_ENV}`);
		assert.equal(typeof result.sdk.createAgentSession, "function");
		assert.equal(typeof result.sdk.SessionManager.create, "function");
	});

	it("fails closed when the module misses a required export", async () => {
		const result = await loadHostSdk({ env: { [SDK_PATH_ENV]: INCOMPLETE_FIXTURE } });
		assert.match(result.error, /is not a usable .* SDK/);
		assert.match(result.error, /missing SessionManager\.create/);
		assert.deepEqual(result.missing, ["SessionManager.create"]);
	});

	it("reports an import failure with the entry path", async () => {
		const tmp = tempDir();
		const entry = join(tmp, "broken.js");
		writeFileSync(entry, "throw new Error('fixture import failure');\n");
		const result = await loadHostSdk({ env: { [SDK_PATH_ENV]: entry } });
		assert.match(result.error, /failed to import/);
		assert.match(result.error, /fixture import failure/);
		assert.equal(result.entryPath, resolve(entry));
	});

	it("uses the injected importer URL for the resolved entry", async () => {
		const tmp = tempDir();
		const entry = writePackageEntry(join(tmp, "installed"));
		const seen = [];
		const result = await loadHostSdk({
			env: { [SDK_PATH_ENV]: entry },
			importer: async (url) => {
				seen.push(url);
				return { createAgentSession: () => {}, SessionManager: { create: () => ({}) } };
			},
		});
		assert.deepEqual(seen, [pathToFileURL(resolve(entry)).href]);
		assert.equal(result.error, undefined);
	});

	it("classifies missing exports without importing anything", () => {
		assert.deepEqual(missingSdkExports({}), ["createAgentSession", "SessionManager.create"]);
		assert.deepEqual(missingSdkExports({ createAgentSession: () => {}, SessionManager: {} }), ["SessionManager.create"]);
		assert.deepEqual(missingSdkExports({ createAgentSession: () => {}, SessionManager: { create: () => {} } }), []);
	});
});

/**
 * Repository-level portability guards, migrated verbatim from the removed
 * `test/host-package.test.js` (the private-seam route they belonged to is gone).
 */
function walkSource(dir, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".browser-ui") {
				continue;
			}
			walkSource(full, acc);
			continue;
		}
		acc.push(full);
	}
	return acc;
}

describe("host code stays portable", () => {
	it("contains no hardcoded personal installation paths", () => {
		const files = walkSource(join(REPO_ROOT, "src"));
		assert.equal(files.length > 0, true);
		const offenders = [];
		for (const file of files) {
			if (!/\.(js|html|css)$/.test(file) || statSync(file).size > 512 * 1024) {
				continue;
			}
			const text = readFileSync(file, "utf8");
			for (const pattern of [/\b[A-Za-z]:\\\\?Users\\?/i, /AppData[\\/]Roaming/i, /npm[\\/]node_modules[\\/]@earendil-works/i]) {
				if (pattern.test(text)) {
					offenders.push(`${file}: ${pattern}`);
				}
			}
		}
		assert.deepEqual(offenders, []);
	});

	it("does not import the bundled CLI entry (it would boot user extensions)", () => {
		const files = [...walkSource(join(REPO_ROOT, "src")), ...walkSource(join(REPO_ROOT, "test"))];
		const offenders = files.filter((file) => {
			if (!/\.js$/.test(file) || statSync(file).size > 512 * 1024) {
				return false;
			}
			const text = readFileSync(file, "utf8");
			return /import\s*\(\s*["'][^"']*bundle\/cli\.js|from\s+["'][^"']*bundle\/cli\.js/.test(text);
		});
		assert.deepEqual(offenders, []);
	});
});
