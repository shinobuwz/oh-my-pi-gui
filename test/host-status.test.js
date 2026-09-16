/**
 * SDK-host status adapter (work group 3).
 *
 * The adapter is driven by a fake `AgentSession` plus an injected `execFile`, so cwd, the
 * read-only Git query, token aggregation, context usage, event refresh and disposal are
 * deterministic and involve no real repository or subprocess.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STATUS_LIMITS } from "../src/core/git-status.js";
import { HostStatusBridge, readSessionCwd } from "../src/host/status.js";

function usage(overrides = {}) {
	return { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, ...overrides };
}

function message(role, messageUsage) {
	return { type: "message", message: { role, usage: messageUsage } };
}

/** execFile double: each call shifts one scripted result and records the exact arguments. */
function makeExecFile(results) {
	const calls = [];
	let killed = 0;
	const execFile = (file, args, options, callback) => {
		calls.push({ file, args, options });
		const result = results.shift() ?? { error: Object.assign(new Error("missing fixture"), { code: "ENOENT" }) };
		const child = { kill: () => { killed += 1; } };
		queueMicrotask(() => callback(result.error ?? null, result.stdout ?? "", result.stderr ?? ""));
		return child;
	};
	return { execFile, calls, getKilled: () => killed };
}

/** Let the throttled timer and the queued Git callbacks settle. */
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeSession({
	cwd = "E:/workspace/project",
	entries = [],
	contextUsage = undefined,
	model = { contextWindow: 128000, provider: "private", id: "hidden", apiKey: "should-not-leak" },
	manager = null,
	onGetContextUsage = null,
} = {}) {
	const listeners = new Set();
	const sessionManager = manager ?? {
		getCwd: () => cwd,
		getBranch: () => entries,
		getEntries: () => entries,
	};
	const session = {
		model,
		sessionManager,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event) {
			for (const listener of [...listeners]) {
				listener(event);
			}
		},
		getContextUsage() {
			if (typeof onGetContextUsage === "function") {
				return onGetContextUsage();
			}
			return contextUsage;
		},
	};
	return session;
}

function bridgeFor(session, options = {}) {
	return new HostStatusBridge({ session, generation: 5, ...options });
}

describe("SDK host session status", () => {
	it("reads cwd from the public session manager with explicit fallbacks only", () => {
		assert.equal(readSessionCwd(makeSession({ cwd: "E:/workspace/project" })), "E:/workspace/project");
		assert.equal(readSessionCwd({ cwd: "E:/direct" }), "E:/direct", "a session-level cwd stays a valid fallback");
		assert.equal(readSessionCwd({ sessionManager: { getCwd: () => { throw new Error("broken"); } } }), null);
		assert.equal(readSessionCwd({ sessionManager: {}, cwd: "" }), null);
		assert.equal(readSessionCwd(null), null);
	});

	it("never fabricates a cwd: the host session cwd is only used when the public reader is gone", () => {
		const withoutReader = makeSession({ manager: { getBranch: () => [], getEntries: () => [] } });
		const fallback = bridgeFor(withoutReader, { fallbackCwd: "E:/host/session", execFile: makeExecFile([]).execFile });
		assert.equal(fallback.snapshot().cwd, "E:/host/session");
		fallback.dispose();

		const withoutAnything = bridgeFor(makeSession({ cwd: "", manager: { getBranch: () => [] } }), { execFile: makeExecFile([]).execFile });
		assert.equal(withoutAnything.snapshot().cwd, null, "a missing cwd stays unknown instead of a guessed path");
		withoutAnything.dispose();
	});

	it("aggregates the active branch usage and keeps an incomplete total unknown", () => {
		const complete = [message("assistant", usage()), message("toolResult", usage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }))];
		const full = bridgeFor(makeSession({ entries: complete }), { execFile: makeExecFile([{ stdout: "main\n" }]).execFile });
		assert.deepEqual(full.snapshot().tokens, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 });
		full.dispose();

		const incomplete = [message("assistant", usage()), message("toolResult", { input: 1, output: 2, cacheRead: 3 })];
		const partial = bridgeFor(makeSession({ entries: incomplete }), { execFile: makeExecFile([]).execFile });
		assert.deepEqual(partial.snapshot().tokens, { input: 11, output: 22, cacheRead: 33, cacheWrite: 40, total: null });
		partial.dispose();

		const brokenManager = {
			getBranch: () => { throw new Error("no branch"); },
			getEntries: () => { throw new Error("no entries"); },
		};
		const unavailable = bridgeFor(makeSession({ manager: brokenManager }), { execFile: makeExecFile([]).execFile });
		assert.deepEqual(unavailable.snapshot().tokens, { input: null, output: null, cacheRead: null, cacheWrite: null, total: null });
		unavailable.dispose();
	});

	it("reports context usage and window from the public session members", () => {
		const withUsage = bridgeFor(makeSession({ contextUsage: { tokens: 1200, contextWindow: 64000, percent: 1.875 } }), {
			execFile: makeExecFile([]).execFile,
		});
		assert.deepEqual(withUsage.snapshot().contextUsage, { tokens: 1200, contextWindow: 64000, percent: 1.875 });
		withUsage.dispose();

		const windowOnly = bridgeFor(makeSession({ contextUsage: undefined, model: { contextWindow: 32000 } }), { execFile: makeExecFile([]).execFile });
		assert.deepEqual(windowOnly.snapshot().contextUsage, { tokens: null, contextWindow: 32000, percent: null });
		windowOnly.dispose();

		const unknown = bridgeFor(makeSession({ contextUsage: undefined, model: null }), { execFile: makeExecFile([]).execFile });
		assert.equal(unknown.snapshot().contextUsage, null, "no context value is reported instead of a fabricated zero");
		unknown.dispose();

		const throwing = bridgeFor(makeSession({ onGetContextUsage: () => { throw new Error("usage unavailable"); } }), {
			execFile: makeExecFile([]).execFile,
		});
		assert.deepEqual(throwing.snapshot().contextUsage, { tokens: null, contextWindow: 128000, percent: null });
		throwing.dispose();
	});

	it("queries Git with fixed read-only bounds and reports bounded reason codes only", async () => {
		const runner = makeExecFile([
			{ stdout: "feature/one\n" },
			{ error: Object.assign(new Error("detached"), { code: 1 }), stderr: "private stderr" },
			{ stdout: "abc1234\n" },
			{ error: Object.assign(new Error("no repo"), { code: 128 }), stderr: "private stderr" },
			{ error: Object.assign(new Error("no repo again"), { code: 128 }), stderr: "private stderr" },
		]);
		const bridge = bridgeFor(makeSession(), { execFile: runner.execFile });

		assert.deepEqual((await bridge.refresh()).git, { branch: "feature/one", reason: null });
		assert.equal(runner.calls[0].file, "git");
		assert.deepEqual(runner.calls[0].args, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"]);
		assert.equal(runner.calls[0].options.cwd, "E:/workspace/project");
		assert.equal(runner.calls[0].options.shell, false);
		assert.equal(runner.calls[0].options.timeout, STATUS_LIMITS.gitTimeoutMs);
		assert.equal(runner.calls[0].options.maxBuffer, STATUS_LIMITS.maxGitOutputBytes);
		assert.equal(runner.calls[0].options.windowsHide, true);

		assert.deepEqual((await bridge.refresh()).git, { branch: "abc1234", reason: "detached_head" });
		assert.deepEqual(runner.calls[1].args, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"]);
		assert.deepEqual(runner.calls[2].args, ["--no-optional-locks", "rev-parse", "--short", "HEAD"]);

		const nonRepo = await bridge.refresh();
		assert.deepEqual(nonRepo.git, { branch: null, reason: "not_repo" });
		const serialized = JSON.stringify(nonRepo);
		assert.equal(serialized.includes("private stderr"), false, "Git command output must never be exposed");
		assert.equal(serialized.includes("should-not-leak"), false, "provider configuration must never be exposed");
		bridge.dispose();

		const missing = makeExecFile([{ error: Object.assign(new Error("git missing"), { code: "ENOENT" }), stderr: "private missing" }]);
		const unavailable = bridgeFor(makeSession(), { execFile: missing.execFile });
		assert.deepEqual((await unavailable.refresh()).git, { branch: null, reason: "git_unavailable" });
		assert.equal(missing.calls.length, 1, "a missing git binary needs no second probe");
		unavailable.dispose();
	});

	it("short-circuits a killed Git timeout without a second probe", async () => {
		const runner = makeExecFile([{ error: Object.assign(new Error("timeout"), { code: null, killed: true, signal: "SIGTERM" }) }]);
		const bridge = bridgeFor(makeSession(), { execFile: runner.execFile });
		assert.deepEqual((await bridge.refresh()).git, { branch: null, reason: "git_timeout" });
		assert.equal(runner.calls.length, 1);
		bridge.dispose();
	});

	it("refreshes the cached branch after the session events that change it", async () => {
		const runner = makeExecFile([{ stdout: "main\n" }, { stdout: "next\n" }, { stdout: "after-compaction\n" }]);
		const session = makeSession();
		const bridge = bridgeFor(session, { execFile: runner.execFile, refreshThrottleMs: 0 });
		await bridge.refresh();
		assert.equal(bridge.snapshot().git.branch, "main");

		session.emit({ type: "message_end" });
		await settle();
		assert.equal(bridge.snapshot().git.branch, "next", "a message_end event refreshes the branch through the shared throttle");

		session.emit({ type: "compaction_end" });
		await settle();
		assert.equal(bridge.snapshot().git.branch, "after-compaction");

		bridge.dispose();
		assert.equal(runner.calls.length, 3, "disposal must stop further refreshes");
		session.emit({ type: "message_end" });
		await settle();
		assert.equal(runner.calls.length, 3);
	});

	it("stops timers, children and session references on dispose and ignores late results", async () => {
		let lateCallback = null;
		let killed = 0;
		const calls = [];
		const execFile = (file, args, options, callback) => {
			calls.push({ file, args, options });
			lateCallback = callback;
			return { kill: () => { killed += 1; } };
		};
		const session = makeSession();
		const bridge = bridgeFor(session, { execFile, refreshThrottleMs: 20 });
		session.emit({ type: "message_end" });
		const before = bridge.snapshot().revision;
		bridge.dispose();

		assert.equal(bridge.active, false);
		const disposed = bridge.snapshot();
		assert.equal(disposed.available, false);
		assert.equal(disposed.cwd, null);
		assert.equal(disposed.git.reason, "disposed");
		assert.equal(disposed.revision, before, "no late event may write after disposal");
		assert.equal(JSON.stringify(disposed).includes("E:/workspace/project"), false);
		assert.equal(killed, 1, "the in-flight Git child is cancelled");
		assert.equal(calls.length, 1, "no throttled refresh may start after disposal");

		// A late child result must not resurrect the adapter.
		lateCallback(null, "late-branch\n", "");
		await settle();
		const after = bridge.snapshot();
		assert.equal(after.available, false);
		assert.equal(after.revision, before);
		assert.equal(JSON.stringify(after).includes("late-branch"), false);
		assert.equal(calls.length, 1);
		bridge.dispose();
	});

	it("requires a session", () => {
		assert.throws(() => new HostStatusBridge({ session: null, generation: 1 }), /AgentSession/);
		assert.throws(() => new HostStatusBridge({ session: makeSession(), generation: 0 }), /positive integer/);
	});
});
