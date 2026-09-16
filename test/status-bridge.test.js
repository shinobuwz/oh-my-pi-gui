import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	STATUS_LIMITS,
	StatusBridge,
	aggregateUsageEntries,
	readContextUsage,
} from "../src/adapter/status-bridge.js";

function usage(overrides = {}) {
	return {
		input: 10,
		output: 20,
		cacheRead: 30,
		cacheWrite: 40,
		...overrides,
	};
}

function message(role, messageUsage) {
	return { type: "message", message: { role, usage: messageUsage } };
}

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

function context({ cwd = "E:/workspace/project", entries = [], contextUsage = undefined, modelWindow = 128000, getBranch = true } = {}) {
	const sessionManager = {};
	if (getBranch) {
		sessionManager.getBranch = () => entries;
	}
	return {
		cwd,
		model: modelWindow === undefined ? undefined : { contextWindow: modelWindow, provider: "private", id: "hidden" },
		getContextUsage: () => contextUsage,
		sessionManager,
	};
}

async function refresh(bridge) {
	await bridge.refresh();
	return bridge.snapshot();
}

describe("current-session status bridge", () => {
	it("aggregates documented usage fields and keeps absent values null", () => {
		const entries = [
			message("user", usage({ input: 999 })),
			message("assistant", usage({ input: 100, cacheRead: 5 })),
			message("toolResult", usage({ output: 7, cacheWrite: 8 })),
			{ type: "compaction", usage: usage({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6 }) },
			{ type: "branch_summary", usage: usage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }) },
			{ type: "custom", usage: usage({ input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 }) },
		];
		assert.deepEqual(aggregateUsageEntries(entries), {
			input: 114,
			output: 33,
			cacheRead: 43,
			cacheWrite: 58,
			total: 248,
		});

		assert.deepEqual(aggregateUsageEntries([
			message("assistant", { input: 4, output: Number.NaN, cacheRead: -1 }),
		]), {
			input: 4,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			total: null,
		});
		assert.deepEqual(aggregateUsageEntries([
			message("assistant", usage()),
			message("toolResult", { input: 1, output: 2, cacheRead: 3 }),
		]), {
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 40,
			total: null,
		});
		assert.deepEqual(aggregateUsageEntries([]), {
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			total: null,
		});
	});

	it("uses the active branch and falls back only when the branch reader is unavailable", () => {
		const branchEntries = [message("assistant", usage({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }))];
		const allEntries = [message("assistant", usage({ input: 100, output: 100, cacheRead: 100, cacheWrite: 100 }))];
		let branchCalls = 0;
		let entriesCalls = 0;
		const manager = {
			getBranch: () => {
				branchCalls += 1;
				return branchEntries;
			},
			getEntries: () => {
				entriesCalls += 1;
				return allEntries;
			},
		};
		const bridge = new StatusBridge({
			ctx: { ...context({ entries: [] }), sessionManager: manager },
			generation: 1,
			execFile: makeExecFile([{ stdout: "main\n" }]).execFile,
		});
		assert.deepEqual(bridge.snapshot().tokens, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 });
		assert.equal(branchCalls, 1);
		assert.equal(entriesCalls, 0);
		bridge.dispose();

		const fallbackManager = {
			getBranch: () => { throw new Error("branch unavailable"); },
			getEntries: () => allEntries,
		};
		const fallback = new StatusBridge({
			ctx: { ...context({ entries: [] }), sessionManager: fallbackManager },
			generation: 2,
			execFile: makeExecFile([{ stdout: "main\n" }]).execFile,
		});
		assert.deepEqual(fallback.snapshot().tokens, { input: 100, output: 100, cacheRead: 100, cacheWrite: 100, total: 400 });
		fallback.dispose();
	});

	it("reports known and unknown context values without deriving missing usage", () => {
		assert.deepEqual(readContextUsage(context({ contextUsage: undefined, modelWindow: 64000 })), {
			tokens: null,
			contextWindow: 64000,
			percent: null,
		});
		assert.deepEqual(readContextUsage(context({ contextUsage: { tokens: 1200, contextWindow: 64000, percent: 1.875 } })), {
			tokens: 1200,
			contextWindow: 64000,
			percent: 1.875,
		});
		assert.equal(readContextUsage(context({ contextUsage: undefined, modelWindow: null })), null);
	});

	it("queries normal, unborn and detached Git states with bounded safe execFile options", async () => {
		const normalRunner = makeExecFile([{ stdout: "feature/unborn\n" }]);
		const normal = new StatusBridge({ ctx: context(), generation: 3, execFile: normalRunner.execFile });
		assert.deepEqual((await refresh(normal)).git, { branch: "feature/unborn", reason: null });
		assert.equal(normalRunner.calls[0].file, "git");
		assert.deepEqual(normalRunner.calls[0].args, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"]);
		assert.equal(normalRunner.calls[0].options.cwd, "E:/workspace/project");
		assert.equal(normalRunner.calls[0].options.shell, false);
		assert.equal(normalRunner.calls[0].options.timeout, STATUS_LIMITS.gitTimeoutMs);
		assert.equal(normalRunner.calls[0].options.maxBuffer, STATUS_LIMITS.maxGitOutputBytes);
		normal.dispose();

		const detachedRunner = makeExecFile([
			{ error: Object.assign(new Error("detached"), { code: 1 }), stderr: "secret stderr" },
			{ stdout: "abc123456789\n" },
		]);
		const detached = new StatusBridge({ ctx: context(), generation: 4, execFile: detachedRunner.execFile });
		assert.deepEqual((await refresh(detached)).git, { branch: "abc123456789", reason: "detached_head" });
		detached.dispose();
	});

	it("short-circuits killed Git timeouts without running the detached-head probe", async () => {
		const runner = makeExecFile([
			{ error: Object.assign(new Error("timeout"), { code: null, killed: true, signal: "SIGTERM" }) },
		]);
		const bridge = new StatusBridge({ ctx: context(), generation: 5, execFile: runner.execFile });
		const snapshot = await refresh(bridge);
		assert.deepEqual(snapshot.git, { branch: null, reason: "git_timeout" });
		assert.equal(runner.calls.length, 1, "a killed Git timeout must not start rev-parse");
		bridge.dispose();
	});

	it("returns non-sensitive reason codes for non-repositories and unavailable Git", async () => {
		const nonRepoRunner = makeExecFile([
			{ error: Object.assign(new Error("secret one"), { code: 128 }), stderr: "private stderr one" },
			{ error: Object.assign(new Error("secret two"), { code: 128 }), stderr: "private stderr two" },
		]);
		const nonRepo = new StatusBridge({ ctx: context(), generation: 5, execFile: nonRepoRunner.execFile });
		const nonRepoSnapshot = await refresh(nonRepo);
		assert.deepEqual(nonRepoSnapshot.git, { branch: null, reason: "not_repo" });
		assert.equal(JSON.stringify(nonRepoSnapshot).includes("private stderr"), false);
		nonRepo.dispose();

		const missingRunner = makeExecFile([{ error: Object.assign(new Error("git missing"), { code: "ENOENT" }), stderr: "private missing" }]);
		const missing = new StatusBridge({ ctx: context(), generation: 6, execFile: missingRunner.execFile });
		const missingSnapshot = await refresh(missing);
		assert.deepEqual(missingSnapshot.git, { branch: null, reason: "git_unavailable" });
		assert.equal(missingRunner.calls.length, 1, "a missing git binary needs no second probe");
		missing.dispose();
	});

	it("refreshes revision on relevant events and disposes old context/process references", async () => {
		const runner = makeExecFile([{ stdout: "main\n" }, { stdout: "next\n" }]);
		const oldCtx = context({ cwd: "E:/old" });
		const bridge = new StatusBridge({ ctx: oldCtx, generation: 7, execFile: runner.execFile, refreshThrottleMs: 0 });
		await refresh(bridge);
		const before = bridge.snapshot().revision;
		bridge.handle({ type: "message_end" }, oldCtx);
		assert.equal(bridge.snapshot().revision > before, true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(bridge.snapshot().git.branch, "next");
		const child = makeExecFile([{ stdout: "late\n" }]);
		const disposed = new StatusBridge({ ctx: context({ cwd: "E:/disposed" }), generation: 8, execFile: child.execFile });
		disposed.dispose();
		assert.equal(disposed.snapshot().available, false);
		assert.equal(disposed.snapshot().cwd, null);
		assert.equal(JSON.stringify(disposed.snapshot()).includes("E:/disposed"), false);
		assert.equal(child.getKilled() >= 1, true);
		bridge.dispose();
	});
});
