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
	// The subagents page counts its fleet and async runs in one tag; the details stay below.
	assert.equal(environment.document.getElementById("subagents-tag").textContent, "1 fleet · 1 async");
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
	// The inspector/transcript explanation lives once on the page, not inside every run.
	assert.equal(asyncRuns.children[0].querySelector(".subagent-run-note"), null);
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
	assert.equal(environment.document.getElementById("subagents-tag").textContent, "", "an unavailable snapshot reports no counts");

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
	assert.equal(environment.document.getElementById("subagents-tag").textContent, "none active");
});

/* -------------------------------------------------------------- page wiring -- */

test("refreshes from the page's own control with the current generation", async () => {
	const environment = createFakeEnvironment({ token: "f".repeat(64) });
	environment.setSnapshot({
		revision: 1,
		generation: 5,
		pending: [],
		reloading: false,
		subagents: { available: true, state: "ready-empty", fleet: { entries: [], omitted: 0 }, asyncSnapshot: { runs: [], omitted: { runs: 0, children: 0, byteLimitExceeded: false } } },
	});
	restore = installPageGlobals(environment);
	await importPage({ bust: `subagents-${++bust}` });
	await environment.runNextTimer();
	assert.equal(environment.document.getElementById("subagents-state").textContent, "Ready · empty");
	assert.equal(environment.document.getElementById("subagents-tag").textContent, "none active");

	// The host answers the refresh with a newer snapshot; the page renders it in place.
	environment.setSnapshot({
		revision: 2,
		generation: 5,
		pending: [],
		reloading: false,
		subagents: {
			available: true,
			state: "ready-data",
			revision: 2,
			fleet: { entries: [{ key: "fleet-1", agent: "scout", goal: "Review <safe>" }], omitted: 0 },
			asyncSnapshot: { runs: [], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
		},
	});
	environment.document.getElementById("subagents-refresh").click();
	await flushTasks();
	const call = environment.fetchCalls.find((entry) => entry.path === "/api/subagents/refresh");
	assert.ok(call, "the page Refresh posts to the subagents refresh route");
	assert.equal(call.options.method, "POST");
	assert.deepEqual(JSON.parse(call.options.body), { generation: 5 });
	assert.equal(environment.document.getElementById("subagents-fleet").children.length, 1);
	assert.equal(environment.document.getElementById("subagents-tag").textContent, "1 fleet · 0 async");
});

test("keeps the page in sync while Chat is the visible page", async () => {
	const { environment, page, inspectCalls } = await bootInspect({ respond: () => inspectOk(SUCCESS_INSPECT) });
	// Polling fills the hidden page too, so switching to it shows a current snapshot rather
	// than an empty shell — and the switch itself rebuilds nothing.
	assert.equal(environment.document.getElementById("subagents-page").classList.contains("hidden"), true);
	assert.equal(environment.document.getElementById("subagents-state").textContent, "Ready");
	assert.equal(environment.document.getElementById("subagents-async").children.length, 1);

	const card = runCard(environment);
	card.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	environment.document.getElementById("page-tab-subagents").click();
	assert.equal(environment.document.getElementById("subagents-page").classList.contains("hidden"), false);
	assert.equal(runCard(environment), card, "switching pages must not rebuild the run card");
	assert.equal(card.querySelector(".subagent-inspect-panel").classList.contains("hidden"), false);

	environment.document.getElementById("page-tab-chat").click();
	assert.equal(page.state.page, "chat");
	assert.equal(card.querySelector(".subagent-inspect-panel").classList.contains("hidden"), false, "the answer survives while Chat is showing");
	assert.equal(inspectCalls.length, 1);
});

/* ---------------------------------------------------------------- structured view -- */

const INSPECT_GENERATION = 3;

function subagentsSnapshot({ revision = 4, runs = [], fleetEntries = [], state = "ready-data", referencedRuns = 0 } = {}) {
	return {
		revision,
		generation: INSPECT_GENERATION,
		pending: [],
		reloading: false,
		subagents: {
			available: true,
			state,
			revision,
			referencedRuns,
			fleet: { entries: fleetEntries, omitted: 0 },
			asyncSnapshot: { runs, omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
		},
	};
}

const INSPECT_RUN = {
	id: "real-async-id",
	state: "running",
	mode: "subagent",
	label: "Review <safe>",
	updatedAt: 1700000001000,
};

/** Boot the page with a subagents snapshot and an inspect stub layered over the real fetch. */
const CHILD_RECORDS = [
	{ id: "child-1", kind: "message", role: "user", text: "Task: 只回复 OK", blocks: [{ type: "text", text: "Task: 只回复 OK" }], timestamp: 1 },
	{
		id: "child-2",
		kind: "message",
		role: "assistant",
		text: "",
		blocks: [
			{ type: "thinking", text: "The task is trivial." },
			{ type: "toolCall", name: "read", arguments: '{"path":"src/browser/app.css"}' },
		],
		timestamp: 2,
	},
];

async function bootInspect({ snapshot = subagentsSnapshot({ runs: [INSPECT_RUN] }), respond, sessionRespond } = {}) {
	const environment = createFakeEnvironment({ token: "d".repeat(64) });
	environment.setSnapshot({ revision: 1, generation: INSPECT_GENERATION, pending: [], reloading: false });
	restore = installPageGlobals(environment);
	const page = await importPage({ bust: `subagents-inspect-${++bust}` });
	await environment.runNextTimer();
	environment.setSnapshot(snapshot);
	await environment.runNextTimer();
	const inspectCalls = [];
	const sessionCalls = [];
	const originalFetch = environment.fetch;
	environment.fetch = async (path, options = {}) => {
		environment.fetchCalls.push({ path, options });
		if (path === "/api/subagents/inspect") {
			inspectCalls.push({ path, options });
			return respond(options, inspectCalls.length);
		}
		if (path === "/api/subagents/session") {
			sessionCalls.push({ path, options });
			const answer = sessionRespond
				? sessionRespond(options, sessionCalls.length)
				: { ok: true, status: 200, json: async () => ({ ok: true, generation: INSPECT_GENERATION, id: "real-async-id", index: 0, messages: CHILD_RECORDS, earlier: false, cursor: null, window: { fileBytes: 4096, truncatedHead: false, records: 2, skipped: 1, limit: 40 } }) };
			return answer;
		}
		return originalFetch(path, options);
	};
	globalThis.fetch = environment.fetch;
	return { environment, page, inspectCalls, sessionCalls };
}

function inspectOk(inspect) {
	return { ok: true, status: 200, json: async () => ({ ok: true, generation: INSPECT_GENERATION, inspect }) };
}

function inspectError(status, code, message) {
	return { ok: false, status, json: async () => ({ ok: false, error: { code, message } }) };
}

const SUCCESS_INSPECT = {
	asyncId: "real-async-id",
	status: "complete",
	label: "Review <safe>",
	task: "probe the structured view\n<script>alert(1)</script>",
	messages: [
		{ role: "user", kind: "text", text: "structured view probe" },
		{ role: "assistant", kind: "toolCall", name: "bash", text: "[tool: bash]" },
		{ role: "toolResult", kind: "text", text: "structured-probe" },
		{ role: "assistant", kind: "text", isError: true, text: "command failed" },
		{ role: "toolResult", kind: "text", name: "read", isError: true, text: "no such file" },
	],
	finalOutput: "DONE",
	truncated: { task: false, messages: 0, finalOutput: false },
};

function runCard(environment) {
	return environment.document.getElementById("subagents-async").children[0];
}

test("sends no structured inspection until the run action is clicked, then renders the payload as text", async () => {
	const { environment, page, inspectCalls } = await bootInspect({ respond: () => inspectOk(SUCCESS_INSPECT) });
	const card = runCard(environment);
	const toggle = card.querySelector(".subagent-inspect-toggle");
	const panel = card.querySelector(".subagent-inspect-panel");

	assert.equal(inspectCalls.length, 0, "rendering the subagents page must not request a structured view");
	assert.equal(toggle.textContent, "Inspect");
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(panel.classList.contains("hidden"), true, "the panel starts collapsed");
	assert.equal(card.querySelector(".subagent-detail"), null, "the transcript stays an explicit action too");

	toggle.click();
	await flushTasks();
	assert.equal(inspectCalls.length, 1);
	assert.equal(inspectCalls[0].options.method, "POST");
	assert.deepEqual(JSON.parse(inspectCalls[0].options.body), { generation: INSPECT_GENERATION, id: "real-async-id" });
	assert.equal(inspectCalls[0].options.headers.Authorization, `Bearer ${"d".repeat(64)}`);
	assert.equal(toggle.getAttribute("aria-expanded"), "true");
	assert.equal(panel.classList.contains("hidden"), false);
	assert.equal(panel.getAttribute("role"), "region");
	assert.equal(panel.tabIndex, 0, "the internally scrolling panel must be keyboard reachable");
	assert.equal(toggle.getAttribute("aria-controls"), panel.id, "the toggle must control the panel it renders");
	assert.equal(toggle.disabled, false);

	const text = panel.textContent;
	assert.match(text, /status: complete/);
	assert.match(text, /label: Review <safe>/);
	assert.match(text, /probe the structured view/);
	// Host text stays text: a markup-looking payload must never become an element.
	assert.equal(panel.querySelector("script"), null);
	assert.match(panel.querySelector(".subagent-inspect-task").textContent, /<script>alert\(1\)<\/script>/);

	const messages = panel.querySelectorAll(".subagent-inspect-message");
	assert.deepEqual(messages.map((item) => item.dataset.kind), ["text", "toolCall", "toolResult", "text", "toolResult"]);
	assert.deepEqual(messages.map((item) => item.querySelector(".subagent-inspect-label").textContent), [
		"user",
		"assistant · tool call: bash",
		"tool result",
		"assistant",
		"tool result: read (error)",
	]);
	assert.equal(messages[1].querySelector(".subagent-inspect-text").textContent, "[tool: bash]");
	assert.equal(messages[2].querySelector(".subagent-inspect-text").textContent, "structured-probe");
	assert.equal(messages[3].dataset.state, "error", "isError results must be marked for the danger colour");
	assert.equal(messages[3].querySelector(".subagent-inspect-text").textContent, "command failed");
	assert.equal(messages[4].dataset.state, "error");
	assert.equal(messages[4].querySelector(".subagent-inspect-text").textContent, "no such file");
	assert.equal(messages[0].dataset.state, undefined);
	assert.equal(panel.querySelector(".subagent-inspect-final").textContent, "DONE");
	assert.equal(panel.querySelectorAll("button").length, 0, "the panel is read-only: no steer/resume/stop controls");
	assert.equal(/steer|resume|\bstop\b/i.test(text), false);

	toggle.click();
	await flushTasks();
	assert.equal(panel.classList.contains("hidden"), true, "the action collapses the panel again");
	assert.equal(inspectCalls.length, 1, "collapsing must not re-request");
	toggle.click();
	await flushTasks();
	assert.equal(panel.classList.contains("hidden"), false);
	// The panel shows a point-in-time answer and has no refresh control, so every genuine open
	// takes a fresh snapshot instead of freezing a running run on a stale one.
	assert.equal(inspectCalls.length, 2, "re-opening asks the host for a current snapshot");
	assert.deepEqual(JSON.parse(inspectCalls[1].options.body), { generation: INSPECT_GENERATION, id: "real-async-id" });
	assert.equal(page.state.subagentInspects.get("run:real-async-id").status, "done");
});

test("opens the structured view from the chat row of a subagent tool result", async () => {
	const chatPipeline = {
		available: true,
		phase: "idle",
		revision: 2,
		lastError: null,
		messagesFull: true,
		historyIds: ["entry-subagent"],
		messages: [
			{
				id: "entry-subagent",
				entryId: "entry-subagent",
				kind: "message",
				role: "toolResult",
				text: "Async: scout [real-async-id]",
				subagentRunId: "real-async-id",
				toolCallId: "call-subagent",
				toolName: "subagent",
				isError: false,
				blocks: [{ type: "toolResult", name: "subagent", content: "Async: scout [real-async-id]", isError: false, subagentRunId: "real-async-id" }],
				timestamp: 1700000002000,
			},
			{
				id: "entry-bash",
				entryId: "entry-bash",
				kind: "message",
				role: "toolResult",
				text: "just a shell result",
				toolCallId: "call-bash",
				toolName: "bash",
				isError: false,
				blocks: [{ type: "toolResult", name: "bash", content: "just a shell result", isError: false }],
				timestamp: 1700000003000,
			},
		],
	};
	const snapshot = subagentsSnapshot({ runs: [INSPECT_RUN] });
	snapshot.chat = chatPipeline;
	const { environment, inspectCalls } = await bootInspect({ snapshot, respond: () => inspectOk(SUCCESS_INSPECT) });
	const rows = environment.document.getElementById("chat-history").children;
	const subagentRow = [...rows].find((row) => row.dataset.id === "entry-subagent");
	const bashRow = [...rows].find((row) => row.dataset.id === "entry-bash");

	assert.ok(subagentRow, "the subagent tool row renders");
	const chatPanel = subagentRow.querySelector(".subagent-inspect-chat");
	assert.ok(chatPanel, "the chat row can open a structured view");
	const toggle = chatPanel.querySelector(".subagent-inspect-toggle");
	assert.equal(chatPanel.querySelector(".subagent-inspect-panel").classList.contains("hidden"), true, "the chat view starts collapsed");
	assert.equal(bashRow.querySelector(".subagent-inspect"), null, "an ordinary tool result offers no structured view");
	assert.equal(inspectCalls.length, 0, "rendering the chat must not request anything");

	toggle.click();
	await flushTasks();
	assert.equal(inspectCalls.length, 1);
	assert.deepEqual(JSON.parse(inspectCalls[0].options.body), { generation: INSPECT_GENERATION, id: "real-async-id" });
	assert.equal(chatPanel.querySelector(".subagent-inspect-panel").classList.contains("hidden"), false);
	assert.match(chatPanel.textContent, /structured-probe/);
	// The chat scope keeps its own panel state: the page's view of the same run is untouched.
	assert.equal(environment.document.getElementById("subagents-async").querySelector(".subagent-inspect-panel").classList.contains("hidden"), true);
});

test("repaints a chat structured view after the next poll rebuilt the subagents page", async () => {
	// Regression: the subagents page clears its DOM registry on every snapshot revision. A
	// chat panel is not rebuilt by that pass, so clearing the shared registry stranded it on
	// "loading" even though the host had answered.
	let release = null;
	const chatPipeline = {
		available: true,
		phase: "idle",
		revision: 2,
		lastError: null,
		messagesFull: true,
		historyIds: ["entry-subagent"],
		messages: [
			{
				id: "entry-subagent",
				kind: "message",
				role: "toolResult",
				text: "Async: scout [real-async-id]",
				subagentRunId: "real-async-id",
				toolCallId: "call-subagent",
				toolName: "subagent",
				isError: false,
				blocks: [{ type: "toolResult", name: "subagent", content: "Async: scout [real-async-id]", isError: false, subagentRunId: "real-async-id" }],
				timestamp: 1700000002000,
			},
		],
	};
	const snapshot = subagentsSnapshot({ runs: [INSPECT_RUN] });
	snapshot.chat = chatPipeline;
	const { environment, page } = await bootInspect({
		snapshot,
		respond: () => new Promise((resolve) => {
			release = () => resolve(inspectOk(SUCCESS_INSPECT));
		}),
	});
	const toggle = environment.document.getElementById("chat-history").querySelector(".subagent-inspect-chat").querySelector(".subagent-inspect-toggle");
	toggle.click();
	await flushTasks();

	// The next poll rebuilds the page *and* the finished run leaves the bounded async snapshot,
	// which is exactly the state a chat row survives (its panel is `chat:`-scoped, and the route
	// accepts the id the chat row reported). Before the fix this prune dropped the answer and the
	// panel stayed on its loading text forever.
	environment.setSnapshot({ ...subagentsSnapshot({ revision: 5, runs: [] }), chat: { ...chatPipeline, revision: 3 } });
	await environment.runNextTimer();
	// The page prune owns the `run:` key space only: a finished run leaving the snapshot must
	// not delete the chat panel's state, or its answer would be dropped on arrival.
	assert.equal(page.state.subagentInspects.has("chat:real-async-id"), true, "the chat entry survives the page prune");
	assert.equal(page.state.subagentInspectNodes.has("chat:real-async-id"), true, "the chat node stays registered");
	assert.equal(page.state.subagentInspects.has("run:real-async-id"), false, "the page entry for the departed run is pruned");
	release();
	await flushTasks();

	const panel = environment.document.getElementById("chat-history").querySelector(".subagent-inspect-chat");
	assert.match(panel.textContent, /structured-probe/, "the answered chat panel must survive the run leaving the snapshot");
	assert.equal(/Requesting the structured view/.test(panel.textContent), false);
});

test("reports every truncation the host flags and keeps unknown task/output explicit", async () => {
	const payload = {
		asyncId: "real-async-id",
		status: "complete",
		messages: [{ role: "user", kind: "text", text: "tail only" }],
		truncated: { task: true, messages: 3, finalOutput: true },
	};
	const { environment } = await bootInspect({ respond: () => inspectOk(payload) });
	const card = runCard(environment);
	card.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	const panel = card.querySelector(".subagent-inspect-panel");
	const notes = panel.querySelectorAll(".subagent-inspect-note");
	assert.equal(notes.length, 3, "task, dropped messages and final output each get their own note");
	assert.equal(notes.every((note) => note.dataset.state === "warning"), true);
	assert.match(panel.textContent, /Earlier 3 messages were dropped/);
	assert.match(panel.textContent, /task text was truncated/);
	assert.match(panel.textContent, /final output was truncated/);
	assert.match(panel.textContent, /Unknown — no task text was reported/);
	assert.match(panel.textContent, /Unknown — no final output was reported/);
	assert.equal(panel.querySelectorAll(".subagent-inspect-message").length, 1);

	// Zero dropped messages means no truncation note at all.
	const clean = await bootInspect({
		respond: () => inspectOk({ ...payload, truncated: { task: false, messages: 0, finalOutput: false } }),
	});
	const cleanCard = runCard(clean.environment);
	cleanCard.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	assert.equal(cleanCard.querySelector(".subagent-inspect-panel").querySelectorAll(".subagent-inspect-note").length, 0);
});

test("keeps timeout, busy, unavailable, foreign-session and unknown failures distinct", async () => {
	const cases = [
		[504, "inspect_timeout", "the inspect command did not answer within 5000 ms", /Timed out \(inspect_timeout\)/],
		[409, "inspect_busy", "an inspection of this generation is already in flight", /Busy \(inspect_busy\)/],
		[503, "inspect_unavailable", "the inspect command is not registered", /Unavailable \(inspect_unavailable\)/],
		[403, "foreign_session", "this run belongs to another session", /Other session \(foreign_session\)/],
		[502, "inspect_probe_unknown", "no idea", /Failed \(inspect_probe_unknown\): the host reported an unrecognized inspection failure/],
	];
	const { environment } = await bootInspect({
		respond: (_options, call) => {
			const [status, code, message] = cases[Math.min(call - 1, cases.length - 1)];
			return inspectError(status, code, message);
		},
	});
	const card = runCard(environment);
	const toggle = card.querySelector(".subagent-inspect-toggle");
	const status = card.querySelector(".subagent-inspect-status");
	const seen = new Set();
	for (const [index, [, code, message, pattern]] of cases.entries()) {
		if (index > 0) {
			toggle.click(); // collapse the failed panel …
			await flushTasks();
		}
		toggle.click(); // … and re-open it, which retries
		await flushTasks();
		assert.equal(status.dataset.state, "error");
		assert.match(status.textContent, pattern, `${code} must keep its own wording`);
		assert.match(status.textContent, new RegExp(`\\(${code}\\)`), "the code itself must be visible");
		assert.match(
			card.querySelector(".subagent-inspect-panel").textContent,
			new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			"the bounded host message stays visible",
		);
		seen.add(status.textContent);
	}
	assert.equal(seen.size, cases.length, "no two failure codes may collapse into the same sentence");
});

test("renders a running run with no messages as a normal empty state, not an error", async () => {
	const { environment, inspectCalls } = await bootInspect({
		respond: () => inspectOk({ asyncId: "real-async-id", status: "running", messages: [], truncated: { task: false, messages: 0, finalOutput: false } }),
	});
	const card = runCard(environment);
	card.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	assert.equal(inspectCalls.length, 1);
	const panel = card.querySelector(".subagent-inspect-panel");
	assert.equal(panel.querySelector(".subagent-inspect-status").dataset.state, "");
	assert.equal(panel.querySelector(".subagent-inspect-status").textContent, "");
	assert.match(panel.textContent, /still running and its child session has no readable messages yet/);
	assert.match(panel.textContent, /normal, not a failure/);
	assert.equal(/unavailable|error|timed out|failed/i.test(panel.textContent), false);
	assert.equal(panel.querySelector(".subagent-inspect-messages"), null);
	assert.equal(panel.querySelectorAll(".subagent-inspect-note").length, 0);

	// A finished run with no messages says so plainly instead of claiming a failure.
	const finished = await bootInspect({
		respond: () => inspectOk({ asyncId: "real-async-id", status: "complete", messages: [], finalOutput: "", truncated: { task: false, messages: 0, finalOutput: false } }),
	});
	const finishedCard = runCard(finished.environment);
	finishedCard.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	assert.match(finishedCard.querySelector(".subagent-inspect-panel").textContent, /The host returned no messages for this run\./);
});

test("offers the structured view only for child nodes that have an id", async () => {
	const run = {
		...INSPECT_RUN,
		children: [
			{ id: "step:0", label: "plan", state: "done" },
			{ label: "anonymous step", state: "running" },
			{ id: "step:1", state: "done", children: [{ id: "step:1:0", state: "done" }, { state: "running" }] },
		],
	};
	const { environment, page, inspectCalls } = await bootInspect({
		snapshot: subagentsSnapshot({ runs: [run] }),
		respond: () => inspectOk({ ...SUCCESS_INSPECT, childId: "step:0" }),
	});
	const card = runCard(environment);
	const children = card.querySelectorAll(".subagent-child");
	assert.equal(children.length, 5, "id-bearing and id-less nodes both stay visible");

	const withId = children[0];
	const withoutId = children[1];
	assert.equal(withId.querySelector(".subagent-inspect-toggle").textContent, "Inspect");
	assert.match(withId.textContent, /id step:0/);
	assert.equal(withoutId.querySelector(".subagent-inspect"), null, "an id-less node must not get an action");
	assert.equal(withoutId.querySelector(".subagent-inspect-toggle"), null);
	assert.match(withoutId.querySelector(".subagent-inspect-unavailable").textContent, /unavailable/);
	assert.match(withoutId.querySelector(".subagent-inspect-unavailable").textContent, /no id in the status snapshot/);
	assert.match(withoutId.textContent, /anonymous step/);

	// Nested descendants with an id are addressable too; id-less ones say why not.
	assert.equal(children[2].querySelector(".subagent-inspect-toggle") !== null, true);
	assert.equal(children[3].querySelector(".subagent-inspect-toggle") !== null, true);
	assert.equal(children[4].querySelector(".subagent-inspect-unavailable") !== null, true);

	withId.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	assert.equal(inspectCalls.length, 1, "only the clicked node is requested");
	assert.deepEqual(JSON.parse(inspectCalls[0].options.body), { generation: INSPECT_GENERATION, id: "real-async-id", childId: "step:0" });
	assert.match(withId.querySelector(".subagent-inspect-panel").textContent, /child: step:0/);
	assert.equal(withoutId.querySelector(".subagent-inspect-panel"), null);
	assert.equal(page.state.subagentInspects.has("run:real-async-id#step:0"), true);
	assert.equal(page.state.subagentInspects.has("run:real-async-id#anonymous step"), false, "no id may be invented for a node without one");
});

test("keeps an answered structured view when the page is rebuilt by the next poll", async () => {
	const { environment, inspectCalls } = await bootInspect({ respond: () => inspectOk(SUCCESS_INSPECT) });
	const first = runCard(environment);
	first.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	assert.equal(inspectCalls.length, 1);

	environment.setSnapshot(subagentsSnapshot({ revision: 9, runs: [{ ...INSPECT_RUN, state: "completed", updatedAt: 1700000002000 }] }));
	await environment.runNextTimer();
	const rebuilt = runCard(environment);
	assert.notEqual(rebuilt, first, "a changed revision rebuilds the run card");
	const toggle = rebuilt.querySelector(".subagent-inspect-toggle");
	assert.equal(inspectCalls.length, 1, "a poll must never re-request a view the reader already opened");
	assert.equal(toggle.getAttribute("aria-expanded"), "true");
	assert.equal(rebuilt.querySelector(".subagent-inspect-panel").classList.contains("hidden"), false);
	assert.match(rebuilt.querySelector(".subagent-inspect-panel").textContent, /structured-probe/);
});

test("renders a foreground run's transcript instead of pretending a structured view exists", async () => {
	const transcript = "Run: real-async-id\nState: live foreground\nTool: read (ok)\nReview <safe>";
	const { environment, inspectCalls } = await bootInspect({
		respond: () => inspectOk({ kind: "transcript", runId: "real-async-id", lines: 20, text: transcript }),
	});
	const card = runCard(environment);
	const toggle = card.querySelector(".subagent-inspect-toggle");
	toggle.click();
	await flushTasks();
	assert.equal(inspectCalls.length, 1);
	const panel = card.querySelector(".subagent-inspect-panel");
	assert.equal(toggle.textContent, "Hide inspector");
	assert.equal(panel.querySelector(".subagent-inspect-task"), null, "a transcript payload has no task section");
	assert.equal(panel.querySelector(".subagent-inspect-final"), null);
	assert.equal(panel.querySelectorAll(".subagent-inspect-message").length, 0);
	assert.equal(panel.querySelector(".subagent-inspect-transcript").textContent, transcript);
	assert.match(panel.textContent, /blocking \(foreground\) delegation/);
	assert.match(panel.textContent, /run: real-async-id/, "the meta line names the run it inspected");
	assert.equal(/\bUnknown\b/.test(panel.textContent), false, "a transcript must not invent missing fields");
});

test("renders only the fleet fields pi-subagents publishes, plus the child's live context", async () => {
	const { environment } = await bootInspect({
		snapshot: subagentsSnapshot({
			fleetEntries: [
				{ key: "fleet-1", agent: "scout", startedAt: 1700000000000, tokens: { input: 18000, output: 2100, total: 20000, window: 42000, windowPeak: 58000 } },
				{ key: "fleet-2", agent: "worker", role: "review", model: "provider/model", effort: "max", startedAt: 1700000000000 },
			],
		}),
		respond: () => inspectOk(SUCCESS_INSPECT),
	});
	const entries = environment.document.getElementById("subagents-fleet").children;
	assert.equal(entries.length, 2);
	const [withoutOptionalFields, withOptionalFields] = entries;
	assert.match(withoutOptionalFields.textContent, /agent: scout/);
	assert.match(withoutOptionalFields.textContent, /tokens: in 18k · out 2\.1k · total 20k · context 42k · peak 58k/);
	assert.equal(/role:/.test(withoutOptionalFields.textContent), false, "an absent role is not rendered at all");
	assert.equal(/state:/.test(withoutOptionalFields.textContent), false, "the fleet DTO has no state field to render");
	assert.equal(/\bUnknown\b/.test(withoutOptionalFields.textContent), false, "missing fields must never be rendered as Unknown");
	assert.match(withOptionalFields.textContent, /role: review · model: provider\/model · effort: max/);
	assert.equal(/\bUnknown\b/.test(withOptionalFields.textContent), false);
});

test("says where chat-attributed runs stay readable when nothing is active any more", async () => {
	const { environment } = await bootInspect({
		snapshot: subagentsSnapshot({ state: "ready-empty", referencedRuns: 2 }),
		respond: () => inspectOk(SUCCESS_INSPECT),
	});
	const status = environment.document.getElementById("subagents-status");
	assert.match(status.textContent, /No active fleet entries or async runs/);
	assert.match(status.textContent, /2 chat-attributed runs/);
	assert.match(status.textContent, /chat row/);
});

test("loads the full child session for a blocking run instead of stopping at the transcript", async () => {
	const { environment, sessionCalls } = await bootInspect({
		respond: () => inspectOk({ kind: "transcript", runId: "real-async-id", lines: 80, text: "Run: real-async-id\nState: completed" }),
	});
	const card = runCard(environment);
	card.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	await flushTasks();
	assert.equal(sessionCalls.length, 1, "the child session is read once, right after the transcript reply");
	assert.deepEqual(JSON.parse(sessionCalls[0].options.body), { generation: INSPECT_GENERATION, id: "real-async-id", index: 0 });

	const panel = card.querySelector(".subagent-inspect-panel");
	assert.match(panel.textContent, /State: completed/, "the extension transcript stays as the summary");
	const records = panel.querySelectorAll(".chat-message");
	assert.equal(records.length, 2, "the child session records are rendered with the chat rows");
	assert.equal(records[0].dataset.role, "user");
	assert.equal(records[0].querySelector(".chat-text").textContent, "Task: 只回复 OK");
	const thinking = records[1].querySelector(".chat-thinking").querySelector(".chat-block-content");
	assert.equal(thinking.textContent, "The task is trivial.", "thinking content is part of the answer");
	const toolCall = records[1].querySelector(".chat-tool-call").querySelector(".chat-block-content");
	assert.match(toolCall.textContent, /src\/browser\/app\.css/);
	assert.match(panel.textContent, /1 record in this window are session metadata or could not be read/);
	assert.equal(panel.querySelectorAll(".subagent-inspect-toggle").length, 0, "no nested inspector is offered inside the child view");
});

test("pages backwards through a child session and reports a failed read as its own state", async () => {
	let pages = 0;
	const answers = [
		{ ok: true, status: 200, json: async () => ({ ok: true, messages: [CHILD_RECORDS[1]], earlier: true, cursor: 5, window: { records: 6, skipped: 0, truncatedHead: true, limit: 40 } }) },
		{ ok: true, status: 200, json: async () => ({ ok: true, messages: [CHILD_RECORDS[0]], earlier: false, cursor: null, window: { records: 6, skipped: 0, truncatedHead: true, limit: 40 } }) },
	];
	const { environment, sessionCalls } = await bootInspect({
		respond: () => inspectOk({ kind: "transcript", runId: "real-async-id", lines: 80, text: "Run: real-async-id" }),
		sessionRespond: () => { pages += 1; return answers[Math.min(pages, 2) - 1]; },
	});
	const card = runCard(environment);
	card.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	await flushTasks();
	const panel = card.querySelector(".subagent-inspect-panel");
	assert.match(panel.textContent, /file tail/, "a truncated window is disclosed");
	assert.equal(panel.querySelectorAll(".chat-message").length, 1);

	panel.querySelector(".subagent-inspect-more").click();
	await flushTasks();
	assert.deepEqual(JSON.parse(sessionCalls[1].options.body), { generation: INSPECT_GENERATION, id: "real-async-id", index: 0, before: 5 });
	assert.equal(panel.querySelectorAll(".chat-message").length, 2, "the older page is prepended to the newer one");
	assert.match(panel.querySelector(".chat-message").querySelector(".chat-text").textContent, /Task: 只回复 OK/);

	const failed = await bootInspect({
		respond: () => inspectOk({ kind: "transcript", runId: "real-async-id", lines: 80, text: "Run: real-async-id" }),
		sessionRespond: () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: { code: "not_found", message: "this run has no child session file on disk any more (child index 0)" } }) }),
	});
	const failedCard = runCard(failed.environment);
	failedCard.querySelector(".subagent-inspect-toggle").click();
	await flushTasks();
	await flushTasks();
	const failedPanel = failedCard.querySelector(".subagent-inspect-panel");
	assert.match(failedPanel.textContent, /Child session/);
	assert.match(failedPanel.textContent, /Unavailable · Not found \(not_found\)/, "a failed read is reported instead of an empty list");
	assert.match(failedPanel.textContent, /no child session file on disk/, "the host reason reaches the reader");
	assert.equal(failedPanel.querySelectorAll(".chat-message").length, 0);
});
