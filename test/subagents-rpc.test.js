import assert from "node:assert/strict";
import test from "node:test";
import {
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CHILD_STATUS_EVENT,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REPLY_EVENT_PREFIX,
	SUBAGENT_RPC_REQUEST_EVENT,
	SUBAGENT_DETAIL_LINES,
	SubagentsBridge,
} from "../src/core/subagents-rpc.js";

const waitForTurn = () => new Promise((resolve) => setImmediate(resolve));
const waitForHint = () => new Promise((resolve) => setTimeout(resolve, 5));

class FakeEvents {
	constructor() {
		this.handlers = new Map();
		this.requests = [];
		this.onCalls = [];
	}

	on(event, handler) {
		this.onCalls.push(event);
		this.handlers.set(event, handler);
		return () => this.handlers.delete(event);
	}

	emit(event, payload) {
		if (event === SUBAGENT_RPC_REQUEST_EVENT) this.requests.push(payload);
	}

	emitHint(event, payload = {}) {
		this.handlers.get(event)?.(payload);
	}

	reply(request, payload) {
		const handler = this.handlers.get(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`);
		assert.ok(handler, `reply listener exists for ${request.requestId}`);
		handler({ version: 1, requestId: request.requestId, ...payload });
	}
}

function statusData(overrides = {}) {
	return {
		fleet: {
			version: 1,
			entries: [{
				key: "fleet-display-key",
				agent: "reviewer",
				role: "review",
				model: "provider/model",
				effort: "high",
				startedAt: 1700000000000,
				goal: "Review the bounded change",
				tokens: { input: 3, output: 4, total: 7 },
			}],
			totalActive: 1,
			omitted: 0,
		},
		asyncSnapshot: {
			version: 1,
			runs: [{
				id: "async-real-id",
				kind: "subagent",
				state: "running",
				label: "Review",
				goal: "Review the bounded change",
				startedAt: 1700000000000,
				updatedAt: 1700000001000,
				children: [{ id: "child-id", state: "running", label: "Child" }],
			}],
			omitted: { runs: 0, children: 0, byteLimitExceeded: false },
		},
		...overrides,
	};
}

async function bindReady(bridge, events) {
	assert.equal(events.requests[0].method, "ping");
	events.reply(events.requests[0], { success: true, data: { capabilities: { fleetStatus: { version: 1 } } } });
	await waitForTurn();
	assert.equal(events.requests[1].method, "status");
	events.reply(events.requests[1], { success: true, data: statusData() });
	return bridge.bind();
}

test("performs correlated ping/status, projects fleet and async DTOs, and separates their identities", async () => {
	const events = new FakeEvents();
	const bridge = new SubagentsBridge({ events, generation: 4, randomUUID: (() => {
		let next = 0;
		return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
	})() });
	const snapshot = await bindReady(bridge, events);

	assert.equal(snapshot.state, "ready-data");
	assert.equal(snapshot.available, true);
	assert.equal(snapshot.fleet.entries[0].key, "fleet-display-key");
	assert.equal(snapshot.asyncSnapshot.runs[0].id, "async-real-id");
	assert.equal(snapshot.asyncSnapshot.runs[0].updatedAt, 1700000001000);
	assert.equal(Object.hasOwn(snapshot.asyncSnapshot.runs[0], "lastUpdate"), false);
	assert.equal(await bridge.detail(4, { generation: 4, id: "fleet-display-key" }).then((result) => result.code), "not_found");
	assert.equal(events.requests.length, 2, "fleet keys must not trigger targeted RPC");
	bridge.dispose();
});

test("maps a legacy lastUpdate-only run to updatedAt without exposing the old field", async () => {
	const events = new FakeEvents();
	const bridge = new SubagentsBridge({ events, generation: 14, randomUUID: (() => {
		let next = 60;
		return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
	})() });
	const bound = bridge.bind();
	events.reply(events.requests[0], { success: true, data: { capabilities: {} } });
	await waitForTurn();
	events.reply(events.requests[1], {
		success: true,
		data: statusData({ asyncSnapshot: { runs: [
			{ id: "preferred-run", state: "running", updatedAt: 1700000003000, lastUpdate: 1700000004000 },
			{ id: "legacy-run", state: "running", lastUpdate: 1700000005000 },
		] } }),
	});
	await bound;
	const runs = bridge.snapshot().asyncSnapshot.runs;
	assert.equal(runs[0].updatedAt, 1700000003000, "updatedAt takes precedence over the legacy field");
	assert.equal(runs[1].updatedAt, 1700000005000);
	assert.equal(Object.hasOwn(runs[0], "lastUpdate"), false);
	assert.equal(Object.hasOwn(runs[1], "lastUpdate"), false);
	bridge.dispose();
});

test("subscribes to exact lifecycle hints and coalesces them into one untargeted status refresh", async () => {
	const events = new FakeEvents();
	const bridge = new SubagentsBridge({ events, generation: 5, randomUUID: (() => {
		let next = 20;
		return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
	})() });
	const bound = bindReady(bridge, events);
	assert.deepEqual(events.onCalls.slice(0, 4), [
		SUBAGENT_RPC_READY_EVENT,
		SUBAGENT_ASYNC_STARTED_EVENT,
		SUBAGENT_ASYNC_COMPLETE_EVENT,
		SUBAGENT_CHILD_STATUS_EVENT,
	]);
	await bound;

	events.emitHint(SUBAGENT_RPC_READY_EVENT, { ignored: "payload" });
	await waitForHint();
	assert.equal(events.requests.length, 2, "ready must not ping an already available owner");

	events.emitHint(SUBAGENT_ASYNC_STARTED_EVENT, { id: "not-rendered" });
	events.emitHint(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "not-rendered" });
	events.emitHint(SUBAGENT_CHILD_STATUS_EVENT, { id: "not-rendered" });
	await waitForHint();
	assert.equal(events.requests.length, 3);
	assert.equal(events.requests[2].method, "status");
	assert.deepEqual(events.requests[2].params, {}, "hint payloads must never become RPC params");
	events.reply(events.requests[2], { success: true, data: statusData() });
	await waitForTurn();
	bridge.dispose();
});

test("remembers one event refresh while status is in flight and runs exactly one follow-up", async () => {
	const events = new FakeEvents();
	const bridge = new SubagentsBridge({ events, generation: 6, randomUUID: (() => {
		let next = 30;
		return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
	})() });
	await bindReady(bridge, events);

	const refresh = bridge.refresh();
	assert.equal(events.requests[2].method, "status");
	events.emitHint(SUBAGENT_ASYNC_STARTED_EVENT);
	events.emitHint(SUBAGENT_ASYNC_COMPLETE_EVENT);
	events.emitHint(SUBAGENT_CHILD_STATUS_EVENT);
	await waitForHint();
	assert.equal(events.requests.length, 3, "a burst during a refresh must remain one pending refresh");

	events.reply(events.requests[2], {
		success: true,
		data: statusData({
			asyncSnapshot: {
				runs: [{ id: "async-real-id", state: "completed", endedAt: 1700000002000 }],
			},
		}),
	});
	await refresh;
	await waitForHint();
	assert.equal(events.requests.length, 4, "the pending hint must run once after the in-flight refresh completes");
	assert.equal(events.requests[3].method, "status");
	assert.deepEqual(events.requests[3].params, {});
	events.reply(events.requests[3], { success: true, data: statusData() });
	await waitForTurn();
	assert.equal(events.requests.length, 4);
	bridge.dispose();
});

test("a failed status refresh clears the old detail allowlist", async () => {
	const events = new FakeEvents();
	const bridge = new SubagentsBridge({ events, generation: 15, randomUUID: (() => {
		let next = 70;
		return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
	})() });
	await bindReady(bridge, events);
	assert.equal(bridge.snapshot().asyncSnapshot.runs[0].id, "async-real-id");
	const refresh = bridge.refresh();
	assert.equal(events.requests[2].method, "status");
	events.reply(events.requests[2], { success: false, error: { code: "owner_lost", message: "owner unavailable" } });
	await refresh;
	const rejected = await bridge.detail(15, { generation: 15, id: "async-real-id" });
	assert.equal(rejected.code, "not_found");
	assert.match(rejected.message, /not in the current status allowlist/);
	bridge.dispose();
});

test("ready recovers an unavailable owner with bounded ping followed by status", async () => {
	const events = new FakeEvents();
	const bridge = new SubagentsBridge({ events, generation: 7, timeoutMs: 10, randomUUID: (() => {
		let next = 40;
		return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
	})() });
	const initial = bridge.bind();
	await initial;
	assert.equal(bridge.snapshot().state, "unavailable");
	assert.equal(bridge.snapshot().error.code, "timeout");

	events.emitHint(SUBAGENT_RPC_READY_EVENT);
	await waitForHint();
	assert.equal(events.requests[1].method, "ping");
	events.reply(events.requests[1], { success: true, data: { capabilities: {} } });
	await waitForHint();
	assert.equal(events.requests[2].method, "status");
	events.reply(events.requests[2], { success: true, data: statusData() });
	await waitForHint();
	assert.equal(bridge.snapshot().available, true);
	assert.equal(bridge.snapshot().state, "ready-data");
	bridge.dispose();
});

test("retained reconnect DTOs do not authorize old-generation transcript ids", async () => {
	const events = new FakeEvents();
	const bridge = new SubagentsBridge({
		events,
		generation: 12,
		initialSnapshot: {
			available: true,
			state: "ready-data",
			revision: 9,
			fleet: { entries: [], totalActive: 0, omitted: 0 },
			asyncSnapshot: { runs: [{ id: "async-real-id", state: "completed" }], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
		},
		randomUUID: () => "00000000-0000-4000-8000-000000000012",
	});
	assert.equal(await bridge.detail(12, { generation: 12, id: "async-real-id" }).then((result) => result.code), "not_found");
	await bindReady(bridge, events);
	const detail = bridge.detail(12, { generation: 12, id: "async-real-id" });
	events.reply(events.requests[2], { success: true, data: { text: "completed" } });
	assert.equal(await detail.then((result) => result.ok), true);
	bridge.dispose();
});

test("retained seed stays loading and a ready hint during initial timeout triggers recovery", async () => {
	const events = new FakeEvents();
	const bridge = new SubagentsBridge({
		events,
		generation: 13,
		timeoutMs: 10,
		initialSnapshot: {
			available: true,
			state: "ready-data",
			error: { kind: "rpc_error", code: "stale", message: "stale" },
			revision: 11,
			fleet: { entries: [], totalActive: 0, omitted: 0 },
			asyncSnapshot: { runs: [{ id: "retained-run", state: "running" }], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
		},
		randomUUID: (() => {
			let next = 50;
			return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
		})(),
	});
	const initialSnapshot = bridge.snapshot();
	assert.equal(initialSnapshot.available, false);
	assert.equal(initialSnapshot.state, "loading");
	assert.equal(initialSnapshot.error, null);
	assert.equal(initialSnapshot.asyncSnapshot.runs[0].id, "retained-run");

	const initial = bridge.bind();
	events.emitHint(SUBAGENT_RPC_READY_EVENT);
	await initial;
	assert.equal(events.requests.length, 2, "the queued ready hint must begin recovery after the initial timeout");
	assert.equal(events.requests[1].method, "ping");
	events.reply(events.requests[1], { success: true, data: { capabilities: {} } });
	await waitForHint();
	assert.equal(events.requests.length, 3);
	assert.equal(events.requests[2].method, "status");
	assert.deepEqual(events.requests[2].params, {});
	events.reply(events.requests[2], { success: true, data: statusData() });
	await waitForHint();
	assert.equal(bridge.snapshot().available, true);
	assert.equal(bridge.snapshot().state, "ready-data");
	bridge.dispose();
});

test("uses fixed targeted transcript params, redacts secrets, and preserves ordinary paths", async () => {
	const events = new FakeEvents();
	const bridge = new SubagentsBridge({ events, generation: 2, randomUUID: (() => {
		let next = 10;
		return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
	})() });
	await bindReady(bridge, events);
	const detailPromise = bridge.detail(2, { generation: 2, id: "async-real-id" });
	assert.deepEqual(events.requests[2].params, { id: "async-real-id", view: "transcript", lines: SUBAGENT_DETAIL_LINES });
	events.reply(events.requests[2], {
		success: true,
		data: {
			text: "state: running\nasyncDir: C:\\private\\run\nassistant output\nBearer abc.def-token\nkey=abc123\n/tmp/secret.txt\nfinished",
			details: { results: [{ index: 0, agent: "reviewer", success: true, task: "do not expose" }] },
		},
	});
	const detail = await detailPromise;
	assert.equal(detail.ok, true);
	assert.equal(detail.text.includes("private"), false);
	assert.match(detail.text, /Bearer \[redacted\]/);
	assert.match(detail.text, /key=\[redacted\]/);
	assert.equal(detail.text.includes("abc.def-token"), false);
	assert.equal(detail.text.includes("abc123"), false);
	assert.match(detail.text, /\/tmp\/secret\.txt/);
	assert.equal(detail.summary.updatedAt, 1700000001000);
	assert.equal(Object.hasOwn(detail.summary, "lastUpdate"), false);
	assert.equal(detail.summary.results[0].agent, "reviewer");
	assert.equal(Object.hasOwn(detail.summary.results[0], "task"), false);
	bridge.dispose();
});

test("distinguishes timeout and failed replies and ignores mismatched replies", async () => {
	const timeoutEvents = new FakeEvents();
	const bridge = new SubagentsBridge({ events: timeoutEvents, generation: 8, timeoutMs: 10, randomUUID: () => "00000000-0000-4000-8000-000000000020" });
	const timeoutPromise = bridge.bind();
	const request = timeoutEvents.requests[0];
	const handler = timeoutEvents.handlers.get(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`);
	handler({ version: 1, requestId: "00000000-0000-4000-8000-000000000099", success: true, data: {} });
	const timeout = await timeoutPromise;
	assert.equal(timeout.state, "unavailable");
	assert.equal(timeout.error.code, "timeout");

	const failedEvents = new FakeEvents();
	const failed = new SubagentsBridge({ events: failedEvents, generation: 8, timeoutMs: 100, randomUUID: () => "00000000-0000-4000-8000-000000000030" });
	failedEvents.reply(failedEvents.requests[0], { success: false, error: { code: "no_active_session", message: "no current session" } });
	const failureSnapshot = await failed.bind();
	assert.equal(failureSnapshot.state, "error");
	assert.equal(failureSnapshot.error.code, "no_active_session");
	assert.equal(failureSnapshot.error.message, "no current session");
	failed.dispose();
	bridge.dispose();
});
