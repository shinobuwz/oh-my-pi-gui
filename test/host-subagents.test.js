/**
 * SDK-host read-only subagents slice (`src/host/subagents.js`) and its lifecycle wiring.
 *
 * These tests are deterministic: a fake extension event bus plus a fake pi-subagents RPC
 * owner drive the *real* `HostSubagentsBridge` and the real consumer `SubagentsBridge`, so
 * the public RPC envelope, the DTO bound/redaction rules and the failure/timeout/empty
 * distinction are exercised without a model call, a real subagent or the installed package.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CHILD_STATUS_EVENT,
	SUBAGENT_RPC_READY_EVENT,
} from "../src/core/subagents-rpc.js";
import { RequestStore } from "../src/core/request-store.js";
import { createHostLifecycle } from "../src/host/host.js";
import {
	HostSubagentsBridge,
	missingSubagentsChannelExports,
	openSubagentsChannel,
} from "../src/host/subagents.js";
import { createBrowserUIContext } from "../src/host/ui-context.js";
import { createFakeExtensionBus, createFakeSdk } from "./helpers/fake-sdk.js";
import { createFakeSubagentsOwner, emptySubagentsStatusData, subagentsStatusData } from "./helpers/fake-subagents-owner.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHostBridge(bus, options = {}) {
	const logs = [];
	const bridge = new HostSubagentsBridge({
		eventBus: bus,
		generation: options.generation ?? 7,
		logger: (message) => logs.push(message),
		eventDebounceMs: options.eventDebounceMs ?? 5,
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		...(options.session ? { session: options.session } : {}),
		...(options.uiContext ? { uiContext: options.uiContext } : {}),
		...(Number.isFinite(options.inspectTimeoutMs) ? { inspectTimeoutMs: options.inspectTimeoutMs } : {}),
	});
	return { bridge, logs };
}

describe("SDK host subagents channel", () => {
	it("owns the SDK event bus and keeps Pi's default resource discovery", () => {
		const { sdk, calls } = createFakeSdk({ extensionBus: true });
		const channel = openSubagentsChannel({ sdk, cwd: "E:/workspace" });

		assert.equal(channel.available, true);
		assert.equal(channel.reason, null);
		assert.equal(channel.eventBus, calls.eventBuses[0], "the channel must hand back the bus it created");
		assert.equal(calls.eventBuses.length, 1);
		assert.deepEqual(calls.settingsManagers, [{ cwd: "E:/workspace", agentDir: "C:/fixture/agent" }]);
		assert.equal(calls.resourceLoaders.length, 1);
		const options = calls.resourceLoaders[0];
		assert.equal(options.cwd, "E:/workspace", "the session cwd drives resource discovery");
		assert.equal(options.agentDir, "C:/fixture/agent", "the agent directory stays the SDK's own");
		assert.equal(options.eventBus, channel.eventBus, "the loader must share the channel bus with every extension");
		assert.equal(options.settingsManager.cwd, "E:/workspace");
		assert.equal(options.settingsManager.agentDir, "C:/fixture/agent");
	});

	it("reports missing public exports instead of guessing a private seam", () => {
		assert.deepEqual(
			missingSubagentsChannelExports(createFakeSdk().sdk).sort(),
			["DefaultResourceLoader", "SettingsManager.create", "createEventBus", "getAgentDir"],
			"the default fake SDK has no extension-bus surface, exactly like an unknown host shape",
		);
		const channel = openSubagentsChannel({ sdk: createFakeSdk().sdk, cwd: "E:/workspace" });
		assert.equal(channel.available, false);
		assert.equal(channel.eventBus, null);
		assert.equal(channel.resourceLoader, null);
		assert.match(channel.reason, /does not expose the public extensions/);
		assert.match(channel.reason, /createEventBus/);

		const partial = { createEventBus: () => ({ on() {}, emit() {} }), DefaultResourceLoader: class {}, SettingsManager: {} };
		assert.deepEqual(missingSubagentsChannelExports(partial), ["SettingsManager.create", "getAgentDir"]);
		const partialChannel = openSubagentsChannel({ sdk: partial, cwd: "E:/workspace" });
		assert.equal(partialChannel.available, false);
		assert.match(partialChannel.reason, /SettingsManager\.create, getAgentDir/);
	});

	it("reports a bus or agent directory the SDK cannot provide as an explicit reason", () => {
		const throwing = { ...createFakeSdk({ extensionBus: true }).sdk, createEventBus: () => { throw new Error("no bus for you"); } };
		const thrownChannel = openSubagentsChannel({ sdk: throwing, cwd: "E:/workspace" });
		assert.equal(thrownChannel.available, false);
		assert.match(thrownChannel.reason, /could not create the shared extension event bus: no bus for you/);

		const partialBus = { ...createFakeSdk({ extensionBus: true }).sdk, createEventBus: () => ({}) };
		const partialChannel = openSubagentsChannel({ sdk: partialBus, cwd: "E:/workspace" });
		assert.equal(partialChannel.available, false);
		assert.match(partialChannel.reason, /did not return an event bus with on\(\)\/emit\(\)/);

		const noAgentDir = { ...createFakeSdk({ extensionBus: true }).sdk, getAgentDir: () => "" };
		const noAgentDirChannel = openSubagentsChannel({ sdk: noAgentDir, cwd: "E:/workspace" });
		assert.equal(noAgentDirChannel.available, false);
		assert.match(noAgentDirChannel.reason, /getAgentDir\(\) did not return the agent directory/);
	});
});

describe("SDK host subagents adapter", () => {
	it("projects bounded lists with public time fields and keeps fleet keys out of run ids", async () => {
		const bus = createFakeExtensionBus();
		const fleetEntries = Array.from({ length: 40 }, (_value, index) => ({
			key: `fleet-key-${index}`,
			agent: "reviewer",
			startedAt: 1700000000000 + index,
		}));
		const runs = Array.from({ length: 40 }, (_value, index) => ({
			id: `run-${index}`,
			state: "running",
			startedAt: 1700000000000 + index,
			updatedAt: 1700000001000 + index,
		}));
		const owner = createFakeSubagentsOwner(bus, {
			status: (request) => (request.params?.id
				? { text: `transcript for ${request.params.id}` }
				: subagentsStatusData({
					fleet: { version: 1, entries: fleetEntries, totalActive: 40, omitted: 0 },
					asyncSnapshot: { version: 1, runs, omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
				})),
		});
		const { bridge } = createHostBridge(bus);
		await bridge.bind();

		const snapshot = bridge.snapshot();
		assert.equal(snapshot.state, "ready-data");
		assert.equal(snapshot.available, true);
		assert.equal(snapshot.generation, 7);
		assert.equal(snapshot.fleet.entries.length, 32, "the fleet list is bounded at the shared limit");
		assert.equal(snapshot.fleet.omitted, 8, "the omitted count must report what was cut");
		assert.equal(snapshot.asyncSnapshot.runs.length, 32, "the async run list is bounded");
		assert.equal(snapshot.asyncSnapshot.omitted.runs, 8);
		assert.equal(snapshot.asyncSnapshot.runs[0].updatedAt, 1700000001000, "the public updatedAt time field is projected");
		assert.equal(Object.hasOwn(snapshot.asyncSnapshot.runs[0], "lastUpdate"), false, "the legacy private field is not forwarded");
		assert.deepEqual(owner.methods().slice(0, 2), ["ping", "status"], "the bind sends only the read-only ping/status pair");
		assert.deepEqual(owner.requests[1].params, {}, "the untargeted status must carry no params");

		const fleetKey = snapshot.fleet.entries[0].key;
		const viaFleetKey = await bridge.details(7, { generation: 7, id: fleetKey });
		assert.equal(viaFleetKey.ok, false);
		assert.equal(viaFleetKey.code, "not_found");
		assert.match(viaFleetKey.message, /not in the current status allowlist/);
		assert.equal(owner.targeted().length, 0, "a fleet display key must never trigger a targeted RPC");

		const id = snapshot.asyncSnapshot.runs[0].id;
		const detail = await bridge.details(7, { generation: 7, id });
		assert.equal(detail.ok, true);
		assert.equal(detail.id, id);
		assert.equal(detail.text, `transcript for ${id}`);
		assert.deepEqual(owner.targeted().at(-1).params, { id, view: "transcript", lines: owner.detailLines });
		assert.deepEqual([...new Set(owner.methods())].sort(), ["ping", "status"], "no management method may ever be sent");
		owner.dispose();
		bridge.dispose();
	});

	it("distinguishes an empty list, a failed owner and a timeout", async () => {
		const emptyBus = createFakeExtensionBus();
		const emptyOwner = createFakeSubagentsOwner(emptyBus, { status: () => emptySubagentsStatusData() });
		const { bridge: emptyBridge } = createHostBridge(emptyBus);
		const empty = await emptyBridge.bind();
		assert.equal(empty.state, "ready-empty");
		assert.equal(empty.available, true);
		assert.equal(empty.error, null);
		assert.deepEqual(empty.fleet.entries, [], "an owner without work reports emptiness, never invented rows");
		assert.deepEqual(empty.asyncSnapshot.runs, []);
		const emptyRefresh = await emptyBridge.refresh(7, { generation: 7 });
		assert.equal(emptyRefresh.ok, true);
		assert.equal(emptyRefresh.generation, 7);
		assert.equal(emptyRefresh.subagents.state, "ready-empty");
		emptyOwner.dispose();
		emptyBridge.dispose();

		const failedBus = createFakeExtensionBus();
		const { bridge: failedBridge } = createHostBridge(failedBus, { timeoutMs: 20 });
		const failed = await failedBridge.bind();
		assert.equal(failed.state, "unavailable");
		assert.equal(failed.available, false);
		assert.equal(failed.error.code, "timeout", "a missing owner is reported as a bounded timeout");
		const failedRefresh = await failedBridge.refresh(7, { generation: 7 });
		assert.equal(failedRefresh.ok, false);
		assert.equal(failedRefresh.status, 504);
		assert.equal(failedRefresh.code, "timeout");
		assert.equal(failedRefresh.subagents.state, "unavailable", "the failure must still hand the snapshot to the page");
		failedBridge.dispose();

		const errorBus = createFakeExtensionBus();
		errorBus.on("subagents:rpc:v1:request", (request) => {
			errorBus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				method: request.method,
				success: false,
				error: { code: "no_active_session", message: "No active extension context for subagent RPC." },
			});
		});
		const { bridge: errorBridge } = createHostBridge(errorBus);
		const errored = await errorBridge.bind();
		assert.equal(errored.state, "error");
		assert.equal(errored.error.code, "no_active_session");
		assert.equal(errored.error.message, "No active extension context for subagent RPC.");
		const erroredRefresh = await errorBridge.refresh(7, { generation: 7 });
		assert.equal(erroredRefresh.status, 502);
		assert.equal(erroredRefresh.code, "no_active_session");
		errorBridge.dispose();
	});

	it("bounds and redacts the transcript while keeping ordinary path text", async () => {
		const bus = createFakeExtensionBus();
		const secretText = [
			"state: running",
			"assistant output",
			"Bearer abc.def-token",
			"key=abc123",
			"password = 'hunter2'",
			"/tmp/ordinary.txt",
			"x".repeat(40 * 1024),
		].join("\n");
		const owner = createFakeSubagentsOwner(bus, {
			status: (request) => (request.params?.id
				? { text: secretText }
				: subagentsStatusData()),
		});
		const { bridge } = createHostBridge(bus);
		await bridge.bind();

		const detail = await bridge.details(7, { generation: 7, id: "async-real-id" });
		assert.equal(detail.ok, true);
		assert.match(detail.text, /Bearer \[redacted\]/);
		assert.match(detail.text, /key=\[redacted\]/);
		assert.equal(detail.text.includes("abc.def-token"), false);
		assert.equal(detail.text.includes("abc123"), false);
		assert.equal(detail.text.includes("hunter2"), false, "a quoted assignment value is redacted too");
		assert.match(detail.text, /\/tmp\/ordinary\.txt/, "ordinary transcript paths stay readable");
		assert.equal(detail.text.length <= 32 * 1024, true, "the transcript tail stays bounded");
		owner.dispose();
		bridge.dispose();
	});

	it("validates both browser actions before any RPC is sent", async () => {
		const bus = createFakeExtensionBus();
		const owner = createFakeSubagentsOwner(bus);
		const { bridge } = createHostBridge(bus);
		await bridge.bind();
		const before = owner.requests.length;

		const extraRefreshKey = await bridge.refresh(7, { generation: 7, id: "not-accepted" });
		assert.equal(extraRefreshKey.status, 400);
		assert.equal(extraRefreshKey.code, "invalid_body");
		const crossGeneration = await bridge.refresh(6, { generation: 6 });
		assert.equal(crossGeneration.status, 409);
		assert.equal(crossGeneration.code, "stale_generation");
		const mismatchedRefresh = await bridge.refresh(7, { generation: 6 });
		assert.equal(mismatchedRefresh.code, "stale_generation");
		const extraDetailKey = await bridge.details(7, { generation: 7, id: "async-real-id", view: "transcript" });
		assert.equal(extraDetailKey.status, 400);
		assert.equal(extraDetailKey.code, "invalid_body");
		const staleDetail = await bridge.details(6, { generation: 6, id: "async-real-id" });
		assert.equal(staleDetail.status, 409);
		assert.equal(staleDetail.code, "stale_generation");
		assert.equal(owner.requests.length, before, "a refused body must not reach the RPC owner");

		const refreshed = await bridge.refresh(7, { generation: 7 });
		assert.equal(refreshed.ok, true);
		assert.equal(owner.requests.length, before + 1);
		assert.equal(owner.requests.at(-1).method, "status");
		assert.deepEqual(owner.requests.at(-1).params, {});
		owner.dispose();
		bridge.dispose();
	});

	it("coalesces a hint burst into one refresh and stops writing after dispose", async () => {
		const bus = createFakeExtensionBus();
		const owner = createFakeSubagentsOwner(bus);
		const { bridge } = createHostBridge(bus, { eventDebounceMs: 10 });
		await bridge.bind();
		const hints = [SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_CHILD_STATUS_EVENT, SUBAGENT_RPC_READY_EVENT];
		for (const channel of hints) {
			assert.equal(bus.channels().includes(channel), true, `the adapter subscribes to the public hint ${channel}`);
		}
		const afterBind = owner.requests.length;

		bus.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "not-rendered" });
		bus.emit(SUBAGENT_CHILD_STATUS_EVENT, { id: "not-rendered" });
		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "not-rendered" });
		await wait(40);
		assert.equal(owner.requests.length, afterBind + 1, "a hint burst becomes one status refresh");
		assert.equal(owner.requests.at(-1).method, "status");
		assert.deepEqual(owner.requests.at(-1).params, {}, "hint payloads never become RPC params");

		bridge.dispose();
		assert.equal(bridge.active, false);
		const afterDispose = owner.requests.length;
		bus.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "not-rendered" });
		await wait(30);
		assert.deepEqual(await bridge.refresh(7, { generation: 7 }).then((result) => result.code), "stale_generation");
		assert.deepEqual(await bridge.details(7, { generation: 7, id: "async-real-id" }).then((result) => result.code), "stale_generation");
		await wait(10);
		assert.equal(owner.requests.length, afterDispose, "a disposed adapter must not write to the bus again");
		assert.equal(bridge.snapshot().available, false);
		assert.equal(bridge.snapshot().state, "unavailable");
		for (const channel of hints) {
			assert.equal(bus.channels().includes(channel), false, `dispose releases the hint subscription ${channel}`);
		}
		owner.dispose();
	});
});

describe("createHostLifecycle subagents section", () => {
	it("attaches the read-only section and reports not_attached until then", async () => {
		const lifecycle = createHostLifecycle();
		assert.equal(lifecycle.sessionSnapshot(), null);
		assert.deepEqual(await lifecycle.sessionSubagentsDetails(1, { generation: 1, id: "async-real-id" }), {
			ok: false,
			status: 503,
			code: "not_attached",
			message: "the browser subagent status is not attached to a session",
		});
		assert.deepEqual(await lifecycle.sessionSubagentsRefresh(1, { generation: 1 }), {
			ok: false,
			status: 503,
			code: "not_attached",
			message: "the browser subagent status is not attached to a session",
		});

		const adapter = {
			snapshot: () => ({ available: true, state: "ready-empty", revision: 1 }),
			details: async (generation, body) => ({ ok: true, generation, id: body.id, text: "transcript" }),
			refresh: async (generation) => ({ ok: true, generation, subagents: { available: true, state: "ready-empty", revision: 2 } }),
		};
		assert.equal(lifecycle.attachSubagents(adapter), adapter);
		assert.deepEqual(lifecycle.sessionSnapshot(), { subagents: { available: true, state: "ready-empty", revision: 1 } });
		assert.equal((await lifecycle.sessionSubagentsDetails(1, { generation: 1, id: "async-real-id" })).text, "transcript");
		assert.equal((await lifecycle.sessionSubagentsRefresh(1, { generation: 1 })).subagents.revision, 2);

		assert.equal(lifecycle.detachSubagents(), adapter);
		assert.equal(lifecycle.sessionSnapshot(), null);
		assert.equal((await lifecycle.sessionSubagentsRefresh(1, { generation: 1 })).code, "not_attached");
	});

	it("reports an unattached inspect route as not_attached instead of inventing data", async () => {
		const lifecycle = createHostLifecycle();
		assert.deepEqual(await lifecycle.sessionSubagentsInspect(1, { generation: 1, id: "async-real-id" }), {
			ok: false,
			status: 503,
			code: "not_attached",
			message: "the browser subagent status is not attached to a session",
		});
		const adapter = {
			snapshot: () => ({ available: true, state: "ready-empty", revision: 1 }),
			inspect: async (generation, body) => ({ ok: true, generation, inspect: { asyncId: body.id } }),
		};
		lifecycle.attachSubagents(adapter);
		const answered = await lifecycle.sessionSubagentsInspect(1, { generation: 1, id: "async-real-id" });
		assert.equal(answered.ok, true);
		assert.equal(answered.inspect.asyncId, "async-real-id");
	});
});

// --- structured inspection over the real host transport --------------------------------

/**
 * A session double shaped like `AgentSession` for the inspect path: a public command
 * catalog, a `prompt()` that executes extension commands inline, and nothing else. The
 * `prompt()` answer mirrors Pi 0.85.1 exactly: `undefined` for a handled command, `false`
 * for one that is not registered.
 */
function createInspectSession({ commands = ["subagents-inspect-rpc"], onPrompt = null, runner = undefined } = {}) {
	const calls = { prompts: [] };
	const session = {
		extensionRunner: runner !== undefined
			? runner
			: commands === null
				? null
				: { getRegisteredCommands: () => commands.map((invocationName) => ({ invocationName })) },
		prompt(text) {
			calls.prompts.push(text);
			if (typeof onPrompt !== "function") return Promise.resolve(undefined);
			try {
				return Promise.resolve(onPrompt(text));
			} catch (error) {
				return Promise.reject(error);
			}
		},
	};
	return { session, calls };
}

/** Emulate the real extension: one payload line on the dedicated key, retracted right after. */
function emittingExtension(uiContext, { reply = {}, key = "subagent-inspect", requestIdOverride = null } = {}) {
	return (commandText) => {
		const requestId = requestIdOverride ?? /^\/subagents-inspect-rpc (\S+)/.exec(commandText)?.[1] ?? "unknown";
		const body = { asyncId: "async-real-id", requestId, ...reply };
		uiContext.setWidget(key, [`PI_SUBAGENT_INSPECT_JSON:${JSON.stringify(body)}`]);
		uiContext.setWidget(key, undefined);
		return undefined;
	};
}

describe("SDK host structured inspection", () => {
	it("runs the extension command, captures the retracted payload and projects it", async () => {
		const bus = createFakeExtensionBus();
		const owner = createFakeSubagentsOwner(bus);
		const store = new RequestStore();
		const uiContext = createBrowserUIContext({ store, logger: () => {} });
		const { session, calls } = createInspectSession({
			onPrompt: emittingExtension(uiContext, {
				reply: {
					kind: "pi-subagents.inspect-reply",
					version: 1,
					status: "completed",
					label: "Review",
					task: "Review the bounded change",
					messages: [
						{ role: "user", kind: "text", text: "Review the bounded change" },
						{ role: "assistant", kind: "toolCall", text: '{"path":"src/x.js"}', name: "read" },
						{ role: "toolResult", kind: "toolResult", text: "file body", name: "read" },
					],
					finalOutput: "final answer",
				},
			}),
		});
		const { bridge } = createHostBridge(bus, { session, uiContext });
		await bridge.bind();

		const result = await bridge.inspect(7, { generation: 7, id: "async-real-id", lines: 50 });
		assert.equal(result.ok, true);
		assert.equal(result.generation, 7);
		assert.equal(result.inspect.status, "completed");
		assert.equal(result.inspect.task, "Review the bounded change");
		assert.equal(result.inspect.finalOutput, "final answer");
		assert.equal(result.inspect.messages.length, 3);
		assert.equal(result.inspect.messages[1].kind, "toolCall");
		assert.equal(result.inspect.messages[1].name, "read");
		assert.match(calls.prompts[0], /^\/subagents-inspect-rpc [A-Za-z0-9_-]{1,64} async-real-id --lines 50$/);
		assert.equal(uiContext.getWidget("subagent-inspect"), null, "the extension's retraction is respected");
		assert.equal(uiContext.widgetListenerCount(), 0, "the inspect subscription is released after the answer");
		assert.equal(store.pendingCount, 0, "inspection raises no browser dialog");
		owner.dispose();
		bridge.dispose();
	});

	it("refuses to prompt the model when the command is unavailable or not registered", async () => {
		const bus = createFakeExtensionBus();
		const owner = createFakeSubagentsOwner(bus);
		const store = new RequestStore();
		const uiContext = createBrowserUIContext({ store, logger: () => {} });

		for (const [name, options, code] of [
			["no command catalog", { commands: null }, "commands_unavailable"],
			["a broken catalog", { runner: { getRegisteredCommands: () => { throw new Error("invalidated"); } } }, "commands_unavailable"],
			["a catalog without the command", { commands: ["review", "help"] }, "inspect_unavailable"],
		]) {
			const { session, calls } = createInspectSession(options);
			const { bridge } = createHostBridge(bus, { session, uiContext });
			await bridge.bind();
			const result = await bridge.inspect(7, { generation: 7, id: "async-real-id" });
			assert.equal(result.ok, false, name);
			assert.equal(result.status, 503, name);
			assert.equal(result.code, code, name);
			assert.deepEqual(calls.prompts, [], `${name} must never send a prompt that could become a model turn`);
			bridge.dispose();
		}
		owner.dispose();
	});

	it("treats prompt()'s false as a missing command and a rejected prompt as a failure", async () => {
		const bus = createFakeExtensionBus();
		const owner = createFakeSubagentsOwner(bus);
		const uiContext = createBrowserUIContext({ store: new RequestStore(), logger: () => {} });

		const { session: missing, calls: missingCalls } = createInspectSession({ onPrompt: () => false });
		const { bridge: missingBridge } = createHostBridge(bus, { session: missing, uiContext });
		await missingBridge.bind();
		const refused = await missingBridge.inspect(7, { generation: 7, id: "async-real-id" });
		assert.equal(refused.status, 503);
		assert.equal(refused.code, "inspect_unavailable");
		assert.match(refused.message, /not registered/);
		assert.equal(missingCalls.prompts.length, 1, "the answer decides, not a second attempt");
		missingBridge.dispose();

		const { session: throwing, calls: throwingCalls } = createInspectSession({ onPrompt: () => { throw new Error("handler exploded"); } });
		const { bridge: throwingBridge } = createHostBridge(bus, { session: throwing, uiContext });
		await throwingBridge.bind();
		const failed = await throwingBridge.inspect(7, { generation: 7, id: "async-real-id" });
		assert.equal(failed.status, 502);
		assert.equal(failed.code, "inspect_failed");
		assert.equal(throwingCalls.prompts.length, 1, "a rejected command must not be retried");
		throwingBridge.dispose();
		owner.dispose();
	});

	it("bounds the round trip, releases its subscription, and ignores uncorrelated payloads", async () => {
		const bus = createFakeExtensionBus();
		const owner = createFakeSubagentsOwner(bus);
		const uiContext = createBrowserUIContext({ store: new RequestStore(), logger: () => {} });

		const { session: hanging, calls: hangingCalls } = createInspectSession({ onPrompt: () => new Promise(() => {}) });
		const { bridge: hangingBridge } = createHostBridge(bus, { session: hanging, uiContext, inspectTimeoutMs: 20 });
		await hangingBridge.bind();
		const timedOut = await hangingBridge.inspect(7, { generation: 7, id: "async-real-id" });
		assert.equal(timedOut.status, 504);
		assert.equal(timedOut.code, "inspect_timeout");
		assert.equal(hangingCalls.prompts.length, 1, "a wedged command is not retried");
		assert.equal(uiContext.widgetListenerCount(), 0, "a timed-out inspection releases its widget subscription");
		hangingBridge.dispose();

		const { session: foreign, calls: foreignCalls } = createInspectSession({
			onPrompt: emittingExtension(uiContext, { requestIdOverride: "someone-else", reply: { kind: "pi-subagents.inspect-reply", version: 1 } }),
		});
		const { bridge: foreignBridge } = createHostBridge(bus, { session: foreign, uiContext });
		await foreignBridge.bind();
		const uncorrelated = await foreignBridge.inspect(7, { generation: 7, id: "async-real-id" });
		assert.equal(uncorrelated.status, 502);
		assert.equal(uncorrelated.code, "inspect_failed");
		assert.match(uncorrelated.message, /without a structured reply/);
		assert.equal("inspect" in uncorrelated, false, "a payload for another request is discarded, never rendered");
		assert.equal(foreignCalls.prompts.length, 1);
		// After the failed correlation the next request still works: nothing stays in flight.
		const { session: healthy } = createInspectSession({
			onPrompt: emittingExtension(uiContext, { reply: { kind: "pi-subagents.inspect-reply", version: 1, status: "completed" } }),
		});
		foreignBridge.dispose();
		const { bridge: healthyBridge } = createHostBridge(bus, { session: healthy, uiContext });
		await healthyBridge.bind();
		const answered = await healthyBridge.inspect(7, { generation: 7, id: "async-real-id" });
		assert.equal(answered.ok, true);
		healthyBridge.dispose();
		owner.dispose();
	});

	it("reports an answered command without a payload instead of inventing one", async () => {
		const bus = createFakeExtensionBus();
		const owner = createFakeSubagentsOwner(bus);
		const uiContext = createBrowserUIContext({ store: new RequestStore(), logger: () => {} });
		const { session } = createInspectSession({ onPrompt: () => undefined });
		const { bridge } = createHostBridge(bus, { session, uiContext });
		await bridge.bind();
		const result = await bridge.inspect(7, { generation: 7, id: "async-real-id" });
		assert.equal(result.status, 502);
		assert.equal(result.code, "inspect_failed");
		assert.match(result.message, /structured reply/);
		assert.equal(uiContext.getWidgetCapture("subagent-inspect"), null);
		owner.dispose();
		bridge.dispose();
	});

	it("keeps a stray payload for another key or request out of the projection", async () => {
		const bus = createFakeExtensionBus();
		const owner = createFakeSubagentsOwner(bus);
		const uiContext = createBrowserUIContext({ store: new RequestStore(), logger: () => {} });
		uiContext.setWidget("subagent-inspect", ["PI_SUBAGENT_INSPECT_JSON:{not json}"]);
		const { session } = createInspectSession({
			onPrompt: emittingExtension(uiContext, { key: "some-other-widget", reply: { kind: "pi-subagents.inspect-reply", version: 1 } }),
		});
		const { bridge } = createHostBridge(bus, { session, uiContext });
		await bridge.bind();
		const result = await bridge.inspect(7, { generation: 7, id: "async-real-id" });
		assert.equal(result.status, 502);
		assert.equal(result.code, "inspect_failed");
		owner.dispose();
		bridge.dispose();
	});
});
