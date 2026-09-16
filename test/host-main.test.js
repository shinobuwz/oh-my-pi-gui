/**
 * Launcher CLI: argument parsing, `--help`, exit codes, fail-closed startup reporting,
 * signal-driven shutdown and synchronous `exit` cleanup.
 *
 * The host starter is injected, so nothing here needs an SDK, a session or a port; a
 * small subprocess case covers the real `node src/host/main.js` entry point.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { HostStartupError } from "../src/host/host.js";
import { cli, parseArgs, runCli, USAGE } from "../src/host/main.js";
import { PACKAGE_ROOT_ENV, SDK_PATH_ENV } from "../src/host/sdk-loader.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAIN_ENTRY = join(REPO_ROOT, "src", "host", "main.js");

const tempDirs = [];
function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-gui-main-"));
	tempDirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createStream() {
	const chunks = [];
	return {
		chunks,
		write(text) {
			chunks.push(text);
			return true;
		},
		text() {
			return chunks.join("");
		},
	};
}

function createFakeHost({ url = "http://127.0.0.1:4321/#t=deadbeef", closeErrors = [] } = {}) {
	const calls = { keepAlive: 0, close: [], exitCleanup: 0 };
	return {
		url,
		calls,
		keepAlive() {
			calls.keepAlive += 1;
		},
		async close(reason) {
			calls.close.push(reason);
			return { cancelled: [], errors: closeErrors };
		},
		exitCleanup() {
			calls.exitCleanup += 1;
		},
	};
}

function nextTick() {
	return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

describe("launcher arguments", () => {
	it("defaults to the invoker cwd and .browser-ui/url", async () => {
		const tmp = tempDir();
		const host = createFakeHost();
		const stdout = createStream();
		const stderr = createStream();
		const seen = [];
		const result = await runCli({
			argv: [],
			env: {},
			stdout,
			stderr,
			cwdBase: tmp,
			start: async (options) => {
				seen.push(options);
				return host;
			},
		});
		assert.equal(result.code, 0);
		assert.equal(result.host, host);
		assert.equal(result.url, host.url);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].cwd, tmp);
		assert.equal(seen[0].urlFile, join(tmp, ".browser-ui", "url"));
		assert.deepEqual(seen[0].env, {});
		assert.equal(typeof seen[0].logger, "function");
		seen[0].logger("probe");
		assert.match(stderr.text(), /\[pi-gui\] probe/);
		assert.equal(typeof seen[0].print, "function");
		seen[0].print("Pi GUI host ready: fixture");
		assert.equal(stdout.text(), "Pi GUI host ready: fixture\n");
	});

	it("resolves --cwd and --url-file relative to the invoker cwd", async () => {
		const tmp = tempDir();
		const seen = [];
		await runCli({
			argv: ["--cwd", "workspace", "--url-file", join("state", "url")],
			env: {},
			stdout: createStream(),
			stderr: createStream(),
			cwdBase: tmp,
			start: async (options) => {
				seen.push(options);
				return createFakeHost();
			},
		});
		assert.equal(seen[0].cwd, resolve(tmp, "workspace"));
		assert.equal(seen[0].urlFile, resolve(tmp, "state", "url"));
	});

	it("prints usage for --help and rejects unknown or incomplete arguments", async () => {
		assert.deepEqual(parseArgs(["--help"]), { help: true });
		assert.deepEqual(parseArgs(["-h"]), { help: true });
		assert.deepEqual(parseArgs(["--cwd", "a", "--url-file", "b"]), { cwd: "a", urlFile: "b" });
		assert.match(parseArgs(["--cwd"]).error, /--cwd requires a value/);
		assert.match(parseArgs(["--url-file", "--cwd", "x"]).error, /--url-file requires a value/);
		assert.match(parseArgs(["--nope"]).error, /unknown option: --nope/);
		assert.match(parseArgs(["positional"]).error, /unexpected argument: positional/);
		assert.deepEqual(parseArgs(["--nope", "--help"]), { help: true }, "--help must win over other arguments");

		const stdout = createStream();
		const help = await runCli({ argv: ["--help"], stdout, stderr: createStream() });
		assert.equal(help.code, 0);
		assert.match(stdout.text(), /Usage:/);
		assert.match(stdout.text(), new RegExp(SDK_PATH_ENV));
		assert.match(stdout.text(), new RegExp(PACKAGE_ROOT_ENV));
		assert.match(stdout.text(), /ctx\.ui\.custom fails explicitly/);
		assert.equal(USAGE.includes("npm start"), true);

		const stderr = createStream();
		const bad = await runCli({ argv: ["--nope"], stdout: createStream(), stderr });
		assert.equal(bad.code, 2);
		assert.match(stderr.text(), /unknown option: --nope/);
		assert.match(stderr.text(), /--help/);
	});

	it("reports SDK resolution failures with attempts and never prints a URL", async () => {
		const stdout = createStream();
		const stderr = createStream();
		const result = await runCli({
			argv: [],
			env: {},
			stdout,
			stderr,
			start: async () => {
				throw new HostStartupError("could not locate the SDK", {
					stage: "sdk-resolve",
					attempts: ["global npm root /usr/lib/node_modules does not contain the package", "`npm root -g` failed"],
				});
			},
		});
		assert.equal(result.code, 1);
		assert.equal(stdout.text(), "");
		const text = stderr.text();
		assert.match(text, /could not locate the SDK/);
		assert.match(text, /- global npm root \/usr\/lib\/node_modules does not contain the package/);
		assert.match(text, /- `npm root -g` failed/);
		assert.match(text, new RegExp(`set ${SDK_PATH_ENV}`));
	});

	it("does not suggest SDK overrides for non-SDK startup failures", async () => {
		const stderr = createStream();
		const result = await runCli({
			argv: [],
			env: {},
			stdout: createStream(),
			stderr,
			start: async () => {
				throw new Error("the bridge client self-check rejected port 5060");
			},
		});
		assert.equal(result.code, 1);
		assert.match(stderr.text(), /bridge client self-check rejected port 5060/);
		assert.equal(stderr.text().includes(SDK_PATH_ENV), false);
	});
});

describe("launcher shutdown", () => {
	it("releases the host on SIGINT with exit code 130 and removes its handlers", async () => {
		const host = createFakeHost();
		const signals = new EventEmitter();
		const stderr = createStream();
		const promise = cli({ argv: [], env: {}, stdout: createStream(), stderr, signals, start: async () => host });
		await nextTick();
		assert.equal(host.calls.keepAlive, 1, "the launcher must keep the process alive on the listener");
		assert.equal(signals.listenerCount("SIGINT"), 1);
		signals.emit("SIGINT");
		const result = await promise;
		assert.equal(result.code, 130);
		assert.equal(result.shutdownReason, "SIGINT");
		assert.deepEqual(host.calls.close, ["SIGINT"]);
		assert.equal(signals.listenerCount("SIGINT"), 0);
		assert.equal(signals.listenerCount("SIGTERM"), 0);
	});

	it("releases the host on SIGTERM with exit code 143", async () => {
		const host = createFakeHost();
		const signals = new EventEmitter();
		const promise = cli({ argv: [], env: {}, stdout: createStream(), stderr: createStream(), signals, start: async () => host });
		await nextTick();
		signals.emit("SIGTERM");
		const result = await promise;
		assert.equal(result.code, 143);
		assert.deepEqual(host.calls.close, ["SIGTERM"]);
	});

	it("reports cleanup errors without rethrowing", async () => {
		const host = createFakeHost({ closeErrors: ["could not remove the URL file: fixture"] });
		const signals = new EventEmitter();
		const stderr = createStream();
		const promise = cli({ argv: [], env: {}, stdout: createStream(), stderr, signals, start: async () => host });
		await nextTick();
		signals.emit("SIGINT");
		await promise;
		assert.match(stderr.text(), /\[pi-gui\] cleanup: could not remove the URL file: fixture/);
	});

	it("cleans up on an uncaught exception or unhandled rejection with exit code 1", async () => {
		const signals = new EventEmitter();
		const stderr = createStream();
		const host = createFakeHost();
		const promise = cli({ argv: [], env: {}, stdout: createStream(), stderr, signals, start: async () => host });
		await nextTick();
		signals.emit("uncaughtException", new Error("fixture crash"));
		const result = await promise;
		assert.equal(result.code, 1);
		assert.deepEqual(host.calls.close, ["uncaughtException"]);
		assert.match(stderr.text(), /uncaught exception: .*fixture crash/);

		const rejectionHost = createFakeHost();
		const rejectionSignals = new EventEmitter();
		const rejectionPromise = cli({
			argv: [],
			env: {},
			stdout: createStream(),
			stderr: createStream(),
			signals: rejectionSignals,
			start: async () => rejectionHost,
		});
		await nextTick();
		rejectionSignals.emit("unhandledRejection", new Error("fixture rejection"));
		assert.equal((await rejectionPromise).code, 1);
		assert.deepEqual(rejectionHost.calls.close, ["unhandledRejection"]);
	});

	it("runs synchronous exit cleanup for the exit event", async () => {
		const host = createFakeHost();
		const signals = new EventEmitter();
		const promise = cli({ argv: [], env: {}, stdout: createStream(), stderr: createStream(), signals, start: async () => host });
		await nextTick();
		signals.emit("exit", 0);
		assert.equal(host.calls.exitCleanup, 1);
		signals.emit("SIGTERM");
		await promise;
	});

	it("returns a startup failure without installing signal handlers", async () => {
		const signals = new EventEmitter();
		const result = await cli({
			argv: [],
			env: {},
			stdout: createStream(),
			stderr: createStream(),
			signals,
			start: async () => {
				throw new Error("fixture startup failure");
			},
		});
		assert.equal(result.code, 1);
		assert.equal(signals.listenerCount("SIGINT"), 0);
		assert.equal(signals.listenerCount("SIGTERM"), 0);
	});
});

describe("direct launcher entry", () => {
	it("prints usage and exits 0 for --help", () => {
		const result = spawnSync(process.execPath, [MAIN_ENTRY, "--help"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 30000 });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Usage:/);
		assert.match(result.stdout, /local browser GUI host/);
	});

	it("fails closed on a missing explicit SDK path instead of falling back", () => {
		const tmp = tempDir();
		const result = spawnSync(process.execPath, [MAIN_ENTRY], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 30000,
			env: { ...process.env, [SDK_PATH_ENV]: join(tmp, "missing-sdk") },
		});
		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stderr, /refusing to fall back/);
		assert.equal(result.stdout.includes("#t="), false, "no URL may be printed when the SDK cannot be resolved");
	});
});
