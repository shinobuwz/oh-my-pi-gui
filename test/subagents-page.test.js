import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createFakeEnvironment, flushTasks, importPage, installPageGlobals } from "./helpers/fake-dom.js";

let restore = null;
let bust = 0;

afterEach(() => {
	restore?.();
	restore = null;
});

test("renders bounded fleet/async sections and requests transcript details on demand", async () => {
	const environment = createFakeEnvironment({ token: "a".repeat(64) });
	environment.setSnapshot({ revision: 1, generation: 3, pending: [], reloading: false });
	restore = installPageGlobals(environment);
	const page = await importPage({ bust: `subagents-${++bust}` });
	await environment.runNextTimer();

	environment.setSnapshot({
		revision: 2,
		generation: 3,
		pending: [],
		reloading: false,
		subagents: {
			available: true,
			state: "ready-data",
			fleet: { entries: [{ key: "opaque-fleet-key", agent: "reviewer", goal: "Review <safe>", tokens: { input: 1, output: 2, total: 3 } }], omitted: 0 },
			asyncSnapshot: { runs: [{ id: "real-async-id", state: "running", mode: "subagent", label: "Review <safe>", updatedAt: 1700000001000 }], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
		},
	});
	await environment.runNextTimer();
	const fleet = environment.document.getElementById("subagents-fleet");
	const asyncRuns = environment.document.getElementById("subagents-async");
	assert.equal(fleet.children.length, 1);
	assert.match(fleet.textContent, /opaque-fleet-key/);
	assert.match(fleet.textContent, /Review <safe>/);
	assert.equal(asyncRuns.children.length, 1);
	assert.match(asyncRuns.textContent, /real-async-id/);
	assert.match(asyncRuns.textContent, /Review <safe>/);
	assert.match(asyncRuns.textContent, /last update: 2023-11-14T22:13:21\.000Z/);

	const originalFetch = environment.fetch;
	environment.fetch = async (path, options = {}) => {
		environment.fetchCalls.push({ path, options });
		if (path === "/api/subagents/details") {
			return { ok: true, status: 200, json: async () => ({ ok: true, id: "real-async-id", text: "safe transcript\n<script>not markup</script>", summary: { id: "real-async-id", state: "running" } }) };
		}
		return originalFetch(path, options);
	};
	globalThis.fetch = environment.fetch;
	const button = asyncRuns.children[0].querySelector("button");
	button.click();
	await flushTasks();
	const detailCall = environment.fetchCalls.find((call) => call.path === "/api/subagents/details");
	assert.ok(detailCall);
	assert.deepEqual(JSON.parse(detailCall.options.body), { generation: 3, id: "real-async-id" });
	assert.match(asyncRuns.children[0].textContent, /safe transcript/);
	assert.match(asyncRuns.children[0].querySelector("pre").textContent, /<script>not markup<\/script>/);
	assert.equal(page.state.subagentsSnapshot.state, "ready-data");
});

test("renders a changed authoritative async snapshot even when its ready state is unchanged", async () => {
	const environment = createFakeEnvironment({ token: "c".repeat(64) });
	environment.setSnapshot({
		revision: 1,
		generation: 9,
		pending: [],
		reloading: false,
		subagents: {
			available: true,
			state: "ready-data",
			revision: 4,
			fleet: { entries: [], omitted: 0 },
			asyncSnapshot: { runs: [{ id: "run-1", state: "running", updatedAt: 1700000001000 }], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
		},
	});
	restore = installPageGlobals(environment);
	await importPage({ bust: `subagents-${++bust}` });
	await environment.runNextTimer();
	assert.match(environment.document.getElementById("subagents-async").textContent, /state: running/);

	environment.setSnapshot({
		revision: 2,
		generation: 9,
		pending: [],
		reloading: false,
		subagents: {
			available: true,
			state: "ready-data",
			revision: 5,
			fleet: { entries: [], omitted: 0 },
			asyncSnapshot: { runs: [{ id: "run-1", state: "completed", endedAt: 1700000002000 }], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
		},
	});
	await environment.runNextTimer();
	const text = environment.document.getElementById("subagents-async").textContent;
	assert.match(text, /state: completed/);
	assert.match(text, /ended:/);
});

test("keeps timeout, RPC error, and omitted data visibly distinct", async () => {
	const environment = createFakeEnvironment({ token: "b".repeat(64) });
	environment.setSnapshot({
		revision: 1,
		generation: 4,
		pending: [],
		reloading: false,
		subagents: {
			available: false,
			state: "unavailable",
			error: { kind: "timeout", code: "timeout", message: "request expired" },
			fleet: { entries: [], omitted: 2 },
			asyncSnapshot: { runs: [], omitted: { runs: 1, children: 0, byteLimitExceeded: false } },
		},
	});
	restore = installPageGlobals(environment);
	await importPage({ bust: `subagents-${++bust}` });
	await environment.runNextTimer();
	assert.match(environment.document.getElementById("subagents-status").textContent, /timed out/);

	environment.setSnapshot({
		revision: 2,
		generation: 4,
		pending: [],
		reloading: false,
		subagents: {
			available: true,
			state: "ready-empty",
			fleet: { entries: [], omitted: 2 },
			asyncSnapshot: { runs: [], omitted: { runs: 1, children: 0, byteLimitExceeded: false } },
		},
	});
	await environment.runNextTimer();
	assert.match(environment.document.getElementById("subagents-status").textContent, /omitted|truncated/);
});
