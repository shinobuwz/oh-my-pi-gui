/**
 * Host package discovery checks.
 *
 * The prototype resolves the running Pi installation from an explicit override,
 * `argv[1]` (including an anchored package lookup), and never contains a hardcoded
 * personal installation path.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { HOST_PACKAGE_NAME, findGlobalHostPackage, resolveHostPackage, resolveHostPackageFromEntry } from "../src/adapter/host-package.js";
import {
	formatErrorWithCause as formatSelfCheckErrorWithCause,
	hasErrorCode,
	isClientRejectedPortError,
} from "../src/core/bridge-server.js";
import {
	REPO_ROOT,
	createFakeHostPackage,
	formatErrorWithCause,
	isNonRetryablePortError,
	locateHostPackage,
} from "./helpers/host.js";

function walk(dir, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".browser-ui") {
				continue;
			}
			walk(full, acc);
			continue;
		}
		acc.push(full);
	}
	return acc;
}

describe("host package discovery", () => {
	it("finds the running Pi package from the CLI entry point in argv", () => {
		const host = locateHostPackage();
		const cliEntry = join(host.packageRoot, "dist", "bundle", "cli.js");
		const resolved = resolveHostPackage({ env: {}, argv: ["node", cliEntry] });
		assert.equal(resolved.error, undefined);
		assert.equal(resolved.packageRoot, host.packageRoot);
		assert.equal(resolved.version, host.version);
		assert.match(resolved.source, /^argv:/);
	});

	it("prefers a valid explicit override and rejects an invalid one", () => {
		const fake = createFakeHostPackage({ version: "1.2.3" });
		try {
			const viaOverride = resolveHostPackage({ env: { PI_BROWSER_UI_PACKAGE_ROOT: fake.dir }, argv: ["node"] });
			assert.equal(viaOverride.version, "1.2.3");
			assert.equal(viaOverride.source, "env:PI_BROWSER_UI_PACKAGE_ROOT");

			const wrongName = createFakeHostPackage({ name: "not-pi" });
			try {
				const rejected = resolveHostPackage({ env: { PI_BROWSER_UI_PACKAGE_ROOT: wrongName.dir }, argv: ["node"] });
				assert.ok(rejected.error, "a directory that is not the Pi package must be rejected");
				assert.match(rejected.attempts.join(" "), /does not point at a/);
			} finally {
				wrongName.cleanup();
			}
		} finally {
			fake.cleanup();
		}
	});

	it("explains the override when the installation cannot be located", () => {
		const result = resolveHostPackage({ env: {}, argv: ["node", "test"] });
		assert.ok(result.error);
		assert.match(result.error, /PI_BROWSER_UI_PACKAGE_ROOT/);
		assert.equal(result.attempts.length >= 2, true);
	});

	it("reports missing and Bun virtual runtime entries instead of pretending to identify a package", () => {
		const missing = resolveHostPackage({ env: {}, argv: ["node"] });
		assert.ok(missing.error);
		assert.match(missing.error, /process\.argv\[1\] is missing/);
		assert.match(missing.attempts.join(" | "), /process\.argv\[1\] is missing/);

		const bun = resolveHostPackage({ env: {}, argv: ["node", "$bunfs/cli.js"] });
		assert.ok(bun.error);
		assert.match(bun.error, /\$bunfs/);
		assert.match(bun.attempts.join(" | "), /Bun's virtual/);
	});

	it("uses the injected realpath target for a symlinked argv[1] entry", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-realpath-"));
		const packageRoot = join(base, "node_modules", "@earendil-works", "pi-coding-agent");
		const symlinkEntry = join(base, "bin", "pi.js");
		const realEntry = join(packageRoot, "dist", "bundle", "cli.js");
		try {
			mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
			mkdirSync(join(base, "bin"), { recursive: true });
			writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: HOST_PACKAGE_NAME, version: "0.85.1" }));
			writeFileSync(symlinkEntry, "");
			writeFileSync(realEntry, "");
			const realpathCalls = [];
			const resolved = resolveHostPackageFromEntry(symlinkEntry, {
				realpath: (entry) => {
					realpathCalls.push(entry);
					return realEntry;
				},
			});
			assert.deepEqual(realpathCalls, [symlinkEntry]);
			assert.equal(resolved.error, undefined);
			assert.equal(resolved.packageRoot, packageRoot);
			assert.equal(resolved.version, "0.85.1");
			assert.equal(resolved.source, `argv:${symlinkEntry}`);
			assert.equal(resolved.entryPath, realEntry);
			assert.deepEqual(resolved.attempts, [], "a realpath target inside the package should resolve without fallback attempts");

			const highLevel = resolveHostPackage({ env: {}, argv: ["node", symlinkEntry], realpath: () => realEntry });
			assert.equal(highLevel.error, undefined);
			assert.equal(highLevel.entryPath, realEntry, "the high-level resolver must retain the realpathed entry for candidate selection");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("uses argv[1] as the package-resolution anchor when the entry is outside the package root", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-anchor-"));
		const packageRoot = join(base, "node_modules", "@earendil-works", "pi-coding-agent");
		const entry = join(base, "bin", "pi.js");
		try {
			mkdirSync(packageRoot, { recursive: true });
			mkdirSync(join(base, "bin"), { recursive: true });
			writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: HOST_PACKAGE_NAME, version: "0.85.1" }));
			writeFileSync(entry, "");
			const resolved = resolveHostPackage({ env: {}, argv: ["node", entry] });
			assert.equal(resolved.error, undefined);
			assert.equal(resolved.packageRoot, packageRoot);
			assert.match(resolved.source, /^argv-resolve:/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("locates the global installation used by the host binding tests", () => {
		const found = findGlobalHostPackage({
			env: {},
			execFileSync: (command, args, options) => {
				assert.deepEqual(args.slice(-2), ["root", "-g"]);
				return `${join(REPO_ROOT, "does-not-exist")}\n`;
			},
		});
		assert.ok(found.error, "a bogus global root must not be reported as a Pi installation");
	});
});

describe("host wait diagnostics (test harness copies)", () => {
	it("formats fetch causes and identifies a nested bad-port failure", () => {
		const error = new TypeError("fetch failed", { cause: new Error("bad port") });
		assert.equal(formatErrorWithCause(error), "fetch failed; cause: bad port");
		assert.equal(isNonRetryablePortError(error), true);
	});

	it("identifies ERR_UNSAFE_PORT even when it is carried by a cause", () => {
		const error = new TypeError("fetch failed", {
			cause: Object.assign(new Error("client rejected the port"), { code: "ERR_UNSAFE_PORT" }),
		});
		assert.equal(isNonRetryablePortError(error), true);
	});

	it("does not classify connection refusal or an ordinary timeout as a bad port", () => {
		const refused = new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
		});
		const timeout = new TypeError("fetch failed", {
			cause: Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
		});
		assert.equal(isNonRetryablePortError(refused), false);
		assert.equal(isNonRetryablePortError(timeout), false);
	});

	it("deduplicates cyclic causes and caps formatted cause depth", () => {
		const first = new Error("first");
		const second = new Error("second");
		first.cause = second;
		second.cause = first;
		assert.equal(formatErrorWithCause(first), "first; cause: second");

		let root = new Error("cause-1");
		const chain = root;
		for (let index = 2; index <= 9; index += 1) {
			root.cause = new Error(`cause-${index}`);
			root = root.cause;
		}
		const formatted = formatErrorWithCause(chain);
		assert.equal(formatted.split("; cause: ").length, 8, "the helper must stop at its eight-entry depth limit");
		assert.match(formatted, /cause-1; cause: cause-2/);
		assert.doesNotMatch(formatted, /cause-9/);
	});
});

describe("production self-check diagnostics (src/core/bridge-server.js)", () => {
	it("formats the same cause chain and redacts an embedded bearer token", () => {
		const error = new TypeError("fetch failed", { cause: new Error("bad port") });
		assert.equal(formatSelfCheckErrorWithCause(error), "fetch failed; cause: bad port");

		const token = "0".repeat(64);
		const withToken = new TypeError("fetch failed", {
			cause: Object.assign(new Error(`client rejected the port for token ${token}`), { code: "ERR_UNSAFE_PORT" }),
		});
		assert.equal(formatSelfCheckErrorWithCause(withToken, token), "fetch failed; cause: client rejected the port for token [redacted]");
		assert.equal(formatSelfCheckErrorWithCause(withToken, token).includes(token), false);
	});

	it("classifies client-rejected ports exactly like the production self-check", () => {
		const codeOnly = new TypeError("fetch failed", {
			cause: Object.assign(new Error("client rejected the selected port"), { code: "ERR_UNSAFE_PORT" }),
		});
		assert.equal(
			isClientRejectedPortError(codeOnly),
			true,
			"the production ERR_UNSAFE_PORT branch must stay and must not depend on bad-port text",
		);
		assert.equal(isClientRejectedPortError(new TypeError("fetch failed", { cause: new Error("bad port") })), true);
		assert.equal(isClientRejectedPortError(new TypeError("fetch failed", { cause: new Error("unsafe-port") })), true);

		const refused = new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
		});
		const timedOut = new TypeError("fetch failed", {
			cause: Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
		});
		assert.equal(isClientRejectedPortError(refused), false);
		assert.equal(isClientRejectedPortError(timedOut), false);
		assert.equal(isClientRejectedPortError(undefined), false);
	});

	it("walks nested and cyclic causes while looking for an error code", () => {
		const nested = new TypeError("outer", {
			cause: new Error("middle", { cause: Object.assign(new Error("inner"), { code: "ERR_UNSAFE_PORT" }) }),
		});
		assert.equal(hasErrorCode(nested, "ERR_UNSAFE_PORT"), true);
		assert.equal(hasErrorCode(nested, "ERR_BAD_PORT"), false);

		const first = new Error("first");
		const second = new Error("second");
		first.cause = second;
		second.cause = first;
		assert.equal(hasErrorCode(first, "ERR_UNSAFE_PORT"), false, "a cyclic cause chain must terminate");
	});
});

describe("production code stays portable", () => {
	it("contains no hardcoded personal installation paths", () => {
		const files = [...walk(join(REPO_ROOT, "src")), ...walk(join(REPO_ROOT, "extensions"))];
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
		const files = [...walk(join(REPO_ROOT, "src")), ...walk(join(REPO_ROOT, "extensions")), ...walk(join(REPO_ROOT, "test"))];
		const offenders = files.filter((file) => {
			if (!/\.js$/.test(file) || statSync(file).size > 512 * 1024) {
				return false;
			}
			const text = readFileSync(file, "utf8");
			return /import\s*\(\s*["'][^"']*bundle\/cli\.js|from\s+["'][^"']*bundle\/cli\.js/.test(text);
		});
		assert.deepEqual(offenders, []);
	});

	it("only supports the version the prototype was verified against", () => {
		const host = locateHostPackage();
		assert.equal(host.version, "0.85.1");
		assert.equal(host.name, HOST_PACKAGE_NAME);
	});
});
