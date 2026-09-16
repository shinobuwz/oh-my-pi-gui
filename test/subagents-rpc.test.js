import assert from "node:assert/strict";
import test from "node:test";
import { INSPECT_PAYLOAD_PREFIX, INSPECT_REPLY_KIND, INSPECT_REPLY_VERSION } from "../src/core/inspect-reply.js";
import {
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CHILD_STATUS_EVENT,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REPLY_EVENT_PREFIX,
	SUBAGENT_RPC_REQUEST_EVENT,
	SUBAGENT_DETAIL_LINES,
	SubagentsBridge,
	subagentInspectCommand,
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

// --- structured inspection (extension command + widget payload correlation) ---------------

/** Captured widget line exactly as pi-subagents emits it for one inspect request. */
function inspectPayload(requestId, overrides = {}) {
	return `${INSPECT_PAYLOAD_PREFIX}${JSON.stringify({
		kind: INSPECT_REPLY_KIND,
		version: INSPECT_REPLY_VERSION,
		requestId,
		asyncId: "async-real-id",
		status: "running",
		label: "Review",
		task: "Review the bounded change",
		messages: [
			{ role: "user", kind: "text", text: "Review the bounded change" },
			{ role: "assistant", kind: "toolCall", text: '{"path":"src/x.js"}', name: "read" },
			{ role: "toolResult", kind: "toolResult", text: "file body", name: "read" },
			{ role: "assistant", kind: "text", text: "done" },
		],
		finalOutput: "final answer",
		...overrides,
	})}`;
}

/** Recording inspect transport seam: whatever it returns is the transport's answer. */
function createRunner(handler) {
	const calls = [];
	return {
		calls,
		runner: (commandText, requestId, options) => {
			calls.push({ commandText, requestId, options });
			return handler(commandText, requestId, options);
		},
	};
}

/** Bridge with the standard status bind plus one injected inspect transport. */
async function bindInspectable(events, { runner, inspectTimeoutMs } = {}) {
	const bridge = new SubagentsBridge({
		events,
		generation: 21,
		randomUUID: () => "00000000-0000-4000-8000-0000000000aa",
		...(typeof runner === "function" ? { inspectRunner: runner } : {}),
		...(Number.isFinite(inspectTimeoutMs) ? { inspectTimeoutMs } : {}),
	});
	const snapshot = await bindReady(bridge, events);
	assert.equal(snapshot.state, "ready-data");
	assert.equal(snapshot.asyncSnapshot.runs[0].children[0].id, "child-id", "the child allow-list comes from the current snapshot");
	return bridge;
}

test("inspects one retained run (or child) with the extension command and projects its payload", async () => {
	const events = new FakeEvents();
	const { runner, calls } = createRunner((_text, requestId) => ({ ok: true, line: inspectPayload(requestId) }));
	const bridge = await bindInspectable(events, { runner });
	const requestsBefore = events.requests.length;

	const result = await bridge.inspect(21, { generation: 21, id: "async-real-id", lines: 20 });
	assert.equal(result.ok, true);
	assert.equal(result.generation, 21);
	assert.equal(result.inspect.asyncId, "async-real-id");
	assert.equal(result.inspect.status, "running");
	assert.equal(result.inspect.task, "Review the bounded change");
	assert.equal(result.inspect.finalOutput, "final answer");
	assert.equal(result.inspect.messages.length, 4);
	assert.equal(result.inspect.messages[1].kind, "toolCall");
	assert.deepEqual(result.inspect.truncated, { task: false, messages: 0, finalOutput: false });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].commandText, subagentInspectCommand(calls[0].requestId, "async-real-id", undefined, 20));
	assert.match(calls[0].commandText, /^\/subagents-inspect-rpc [A-Za-z0-9_-]{1,64} async-real-id --lines 20$/);
	assert.equal(calls[0].options.timeoutMs, 5000, "the default inspect deadline is the documented 5s");
	assert.equal(calls[0].options.id, "async-real-id");
	assert.equal(calls[0].options.childId, undefined);
	assert.equal(events.requests.length, requestsBefore, "inspection must never send another in-process RPC");

	const withChild = await bridge.inspect(21, { generation: 21, id: "async-real-id", childId: "child-id" });
	assert.equal(withChild.ok, true);
	assert.equal(calls[1].commandText, subagentInspectCommand(calls[1].requestId, "async-real-id", "child-id", undefined));
	assert.equal(calls[1].options.childId, "child-id");
	bridge.dispose();
});

test("keeps chat-attributed run ids inspectable without widening what the page may name", async () => {
	const events = new FakeEvents();
	const { runner, calls } = createRunner((_text, requestId) => ({ ok: true, line: inspectPayload(requestId) }));
	const bridge = await bindInspectable(events, { runner });

	// A run that left the bounded status snapshot is still reachable from the chat row that
	// named it, because the chat projection attributed the id to a real subagent tool result.
	assert.equal(await bridge.retainReferencedAsyncIds(["chat-run-id"]), 1);
	assert.equal(bridge.retainReferencedAsyncIds(["chat-run-id"]), 0, "duplicates are ignored");
	assert.equal(bridge.retainReferencedAsyncIds("chat-run-id"), 0, "a non-array is ignored");
	assert.equal(bridge.retainReferencedAsyncIds([""]), 0, "an empty id is ignored");
	assert.equal(bridge.retainReferencedAsyncIds(["../etc/passwd"]), 0, "a path-looking string is never retained");
	assert.equal(bridge.retainReferencedAsyncIds(["has space"]), 0, "only opaque id shapes are retained");

	const fromChat = await bridge.inspect(21, { generation: 21, id: "chat-run-id" });
	assert.equal(fromChat.ok, true, "a chat-attributed id is inspectable");
	assert.equal(fromChat.inspect.asyncId, "async-real-id");
	assert.equal(calls.length, 1);

	const stillUnknown = await bridge.inspect(21, { generation: 21, id: "never-reported" });
	assert.equal(stillUnknown.status, 404);
	assert.equal(stillUnknown.code, "not_found");
	// Retention stays bounded: the oldest chat-attributed id is dropped first.
	for (let index = 0; index < 80; index += 1) {
		bridge.retainReferencedAsyncIds([`chat-run-${index}`]);
	}
	const evicted = await bridge.inspect(21, { generation: 21, id: "chat-run-id" });
	assert.equal(evicted.status, 404, "the referenced-id window is bounded");
	const newest = await bridge.inspect(21, { generation: 21, id: "chat-run-79" });
	assert.equal(newest.ok, true);
});

test("refuses unknown ids, fleet keys, unknown child nodes and unusable bodies before the session", async () => {
	const events = new FakeEvents();
	const { runner, calls } = createRunner((_text, requestId) => ({ ok: true, line: inspectPayload(requestId) }));
	const bridge = await bindInspectable(events, { runner });

	const fleetKey = await bridge.inspect(21, { generation: 21, id: "fleet-display-key" });
	assert.equal(fleetKey.status, 404);
	assert.equal(fleetKey.code, "not_found");
	const unknownRun = await bridge.inspect(21, { generation: 21, id: "not-retained" });
	assert.equal(unknownRun.code, "not_found");
	const unknownChild = await bridge.inspect(21, { generation: 21, id: "async-real-id", childId: "not-a-node" });
	assert.equal(unknownChild.status, 404);
	assert.equal(unknownChild.code, "not_found");
	assert.match(unknownChild.message, /child node/);
	// A child node without an id in the snapshot cannot be inspected: it is refused, not guessed.
	const childlessRun = await bridge.inspect(21, { generation: 21, id: "async-real-id", childId: "" });
	assert.equal(childlessRun.status, 400);
	assert.equal(childlessRun.code, "invalid_body");
	const wrongTypes = [
		{ generation: 21, id: "async-real-id", lines: 0 },
		{ generation: 21, id: "async-real-id", lines: 201 },
		{ generation: 21, id: "async-real-id", lines: 1.5 },
		{ generation: 21, id: "async-real-id", lines: "10" },
		{ generation: 21, id: "async-real-id", childId: 5 },
		{ generation: 21, id: "async-real-id", childId: "x".repeat(257) },
	];
	for (const body of wrongTypes) {
		const refused = await bridge.inspect(21, body);
		assert.equal(refused.status, 400, `body ${JSON.stringify(body)} must be refused`);
		assert.equal(refused.code, "invalid_body");
	}
	const extraField = await bridge.inspect(21, { generation: 21, id: "async-real-id", view: "transcript" });
	assert.equal(extraField.code, "invalid_body");
	// Parity with `detail()`: a body without the current generation is a stale generation.
	const noBody = await bridge.inspect(21, undefined);
	assert.equal(noBody.code, "stale_generation");
	assert.equal(calls.length, 0, "no refused body may reach the session");
	assert.equal(events.requests.length, 2, "no refused body may emit an RPC either");
	bridge.dispose();
});

test("maps extension error codes and normalizes internal/unknown codes to inspect_failed", async () => {
	for (const [code, status] of [
		["not_found", 404],
		["foreign_session", 403],
		["stale", 409],
		["no_active_session", 503],
		["invalid_request", 400],
	]) {
		const events = new FakeEvents();
		const { runner } = createRunner((_text, requestId) => ({
			ok: true,
			line: inspectPayload(requestId, { error: { code, message: `extension said ${code}` } }),
		}));
		const bridge = await bindInspectable(events, { runner });
		const result = await bridge.inspect(21, { generation: 21, id: "async-real-id" });
		assert.equal(result.ok, false);
		assert.equal(result.status, status, `${code} must map to HTTP ${status}`);
		assert.equal(result.code, code, `${code} must be preserved as-is`);
		assert.equal(result.message, `extension said ${code}`);
		bridge.dispose();
	}

	for (const code of ["internal", "teapot"]) {
		const events = new FakeEvents();
		const { runner } = createRunner((_text, requestId) => ({
			ok: true,
			line: inspectPayload(requestId, { error: { code, message: "Inspection could not read the async run artifacts." } }),
		}));
		const bridge = await bindInspectable(events, { runner });
		const result = await bridge.inspect(21, { generation: 21, id: "async-real-id" });
		assert.equal(result.ok, false);
		assert.equal(result.status, 502, `${code} must map to 502`);
		assert.equal(result.code, "inspect_failed");
		assert.equal(result.message, "Inspection could not read the async run artifacts.");
		bridge.dispose();
	}
});

test("rejects a malformed, uncorrelated or missing payload instead of inventing data", async () => {
	const cases = [
		{ name: "another request id", answer: { ok: true, line: inspectPayload("someone-else") }, expect: "request_id_mismatch" },
		{ name: "malformed json", answer: { ok: true, line: `${INSPECT_PAYLOAD_PREFIX}{` }, expect: "malformed_json" },
		{ name: "foreign payload", answer: { ok: true, line: "an ordinary widget line" }, expect: "not_inspect_payload" },
		{ name: "no payload at all", answer: { ok: false, reason: "no_payload" }, expect: "without a structured reply" },
		{ name: "an undefined answer", answer: undefined, expect: "no structured reply" },
	];
	for (const entry of cases) {
		const events = new FakeEvents();
		const { runner } = createRunner(() => entry.answer);
		const bridge = await bindInspectable(events, { runner });
		const result = await bridge.inspect(21, { generation: 21, id: "async-real-id" });
		assert.equal(result.ok, false, entry.name);
		assert.equal(result.status, 502, entry.name);
		assert.equal(result.code, "inspect_failed", entry.name);
		assert.match(result.message, new RegExp(entry.expect), entry.name);
		bridge.dispose();
	}
});

test("reports a missing or unenumerable command distinctly and accepts prompt()'s false", async () => {
	const cases = [
		[{ ok: false, reason: "not_registered" }, 503, "inspect_unavailable"],
		[false, 503, "inspect_unavailable"],
		[{ ok: false, reason: "commands_unavailable" }, 503, "commands_unavailable"],
		[{ ok: false, reason: "no_capture" }, 503, "inspect_unavailable"],
		[{ ok: false, reason: "no_session" }, 503, "inspect_unavailable"],
	];
	for (const [answer, status, code] of cases) {
		const events = new FakeEvents();
		const { runner } = createRunner(() => answer);
		const bridge = await bindInspectable(events, { runner });
		const result = await bridge.inspect(21, { generation: 21, id: "async-real-id" });
		assert.equal(result.ok, false);
		assert.equal(result.status, status, JSON.stringify(answer));
		assert.equal(result.code, code, JSON.stringify(answer));
		bridge.dispose();
	}

	// A host without any command channel at all must say so instead of pretending.
	const bareEvents = new FakeEvents();
	const bare = new SubagentsBridge({ events: bareEvents, generation: 21, randomUUID: () => "00000000-0000-4000-8000-0000000000ab" });
	await bindReady(bare, bareEvents);
	const unavailable = await bare.inspect(21, { generation: 21, id: "async-real-id" });
	assert.equal(unavailable.status, 503);
	assert.equal(unavailable.code, "inspect_unavailable");
	bare.dispose();

	// A transport that throws is a bounded failure, never an unhandled rejection.
	const throwEvents = new FakeEvents();
	const { runner: throwing } = createRunner(() => {
		throw new Error("transport exploded");
	});
	const throwingBridge = await bindInspectable(throwEvents, { runner: throwing });
	const thrown = await throwingBridge.inspect(21, { generation: 21, id: "async-real-id" });
	assert.equal(thrown.status, 502);
	assert.equal(thrown.code, "inspect_failed");
	assert.match(thrown.message, /transport exploded/);
	throwingBridge.dispose();
});

test("times out once with a distinct code, releases the slot and never retries", async () => {
	const events = new FakeEvents();
	const { runner, calls } = createRunner(() => new Promise(() => {}));
	const bridge = await bindInspectable(events, { runner, inspectTimeoutMs: 15 });
	const timedOut = await bridge.inspect(21, { generation: 21, id: "async-real-id" });
	assert.equal(timedOut.ok, false);
	assert.equal(timedOut.status, 504);
	assert.equal(timedOut.code, "inspect_timeout");
	assert.match(timedOut.message, /within 15ms/);
	assert.equal(calls.length, 1, "a timeout must not retry");

	// The single-flight slot is free again after the deadline.
	const second = await bridge.inspect(21, { generation: 21, id: "async-real-id" });
	assert.equal(second.code, "inspect_timeout");
	assert.equal(calls.length, 2);
	bridge.dispose();
});

test("allows exactly one inspection in flight and refuses a second one", async () => {
	const events = new FakeEvents();
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const { runner, calls } = createRunner((_text, requestId) => pending.then(() => ({ ok: true, line: inspectPayload(requestId) })));
	const bridge = await bindInspectable(events, { runner });

	const first = bridge.inspect(21, { generation: 21, id: "async-real-id" });
	const second = await bridge.inspect(21, { generation: 21, id: "async-real-id" });
	assert.equal(second.status, 409);
	assert.equal(second.code, "inspect_busy");
	assert.equal(calls.length, 1, "a refused second inspection must not reach the session");
	release();
	const answered = await first;
	assert.equal(answered.ok, true);
	const third = await bridge.inspect(21, { generation: 21, id: "async-real-id" });
	assert.equal(third.ok, true);
	assert.equal(calls.length, 2);
	bridge.dispose();
});

test("refuses a stale generation and a disposed bridge without touching the session", async () => {
	const events = new FakeEvents();
	const { runner, calls } = createRunner((_text, requestId) => ({ ok: true, line: inspectPayload(requestId) }));
	const bridge = await bindInspectable(events, { runner });

	const crossGeneration = await bridge.inspect(20, { generation: 20, id: "async-real-id" });
	assert.equal(crossGeneration.status, 409);
	assert.equal(crossGeneration.code, "stale_generation");
	const mismatched = await bridge.inspect(21, { generation: 20, id: "async-real-id" });
	assert.equal(mismatched.code, "stale_generation");
	assert.equal(calls.length, 0);

	bridge.dispose();
	const afterDispose = await bridge.inspect(21, { generation: 21, id: "async-real-id" });
	assert.equal(afterDispose.status, 409);
	assert.equal(afterDispose.code, "stale_generation");
	assert.equal(calls.length, 0, "a disposed bridge must never run the inspect command");
});

