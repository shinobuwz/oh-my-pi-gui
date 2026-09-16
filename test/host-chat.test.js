/**
 * SDK-session chat adapter (`src/host/chat.js`) driven by a fake `AgentSession`.
 *
 * These tests are deterministic and make no model call: the fake session records
 * `prompt`/`abort`/`subscribe` calls and lets the test emit synthetic session events.
 * They cover the browser contract (phase migration, per-message revisions, `since`
 * deltas, `historyIds`), live-vs-canonical de-duplication (including the persisted
 * toolResult case), delivery mapping, slash-command fail-closed behaviour, stop
 * delegation and `lastError` visibility after acceptance.
 */

import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, it } from "node:test";

import { HostChatBridge } from "../src/host/chat.js";
import { createFakeSdk } from "./helpers/fake-sdk.js";

function userEntry(id, text, timestamp) {
	return {
		type: "message",
		id,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	};
}

function createBridge({ idle = true, entries = [], prompt = null, extensionRunner = null, promptTemplates = [], skills = null } = {}) {
	const fake = createFakeSdk({ idle, entries, prompt });
	fake.session.extensionRunner = extensionRunner;
	fake.session.promptTemplates = promptTemplates;
	fake.session.resourceLoader = skills ? { getSkills: () => ({ skills }) } : null;
	const logs = [];
	const bridge = new HostChatBridge({ session: fake.session, generation: 7, logger: (message) => logs.push(message) });
	return { ...fake, bridge, logs };
}

describe("SDK host chat adapter", () => {
	it("exposes the browser chat contract and follows idle → streaming → idle", () => {
		const entries = [];
		const { bridge, session, listeners } = createBridge({ entries });
		assert.equal(bridge.generation, 7);
		assert.equal(listeners.size, 1, "the adapter must subscribe to the session once");

		let snapshot = bridge.snapshot();
		assert.deepEqual(Object.keys(snapshot).sort(), [
			"available",
			"canFollowUp",
			"canSend",
			"canSteer",
			"hasPendingMessages",
			"historyIds",
			"lastError",
			"leafId",
			"messages",
			"messagesFull",
			"phase",
			"revision",
		]);
		assert.equal(snapshot.available, true);
		assert.equal(snapshot.phase, "idle");
		assert.equal(snapshot.canSend, true);
		assert.equal(snapshot.canSteer, false);
		assert.equal(snapshot.canFollowUp, false);
		assert.equal(snapshot.hasPendingMessages, false);
		assert.equal(snapshot.leafId, null);
		assert.equal(snapshot.lastError, null);

		session.isIdle = false;
		session.isStreaming = true;
		bridge.handle({ type: "agent_start" });
		snapshot = bridge.snapshot();
		assert.equal(snapshot.phase, "streaming");
		assert.equal(snapshot.canSend, false);
		assert.equal(snapshot.canSteer, true);
		assert.equal(snapshot.canFollowUp, true);

		session.pendingMessageCount = 2;
		bridge.handle({ type: "queue_update", steering: ["a"], followUp: ["b"] });
		assert.equal(bridge.snapshot().hasPendingMessages, true, "queued steer/follow-up must be visible");
		session.pendingMessageCount = 0;
		assert.equal(bridge.snapshot().hasPendingMessages, false);

		entries.push(userEntry("user-1", "hello", 1));
		session.isIdle = true;
		session.isStreaming = false;
		bridge.handle({ type: "agent_settled" });
		snapshot = bridge.snapshot();
		assert.equal(snapshot.phase, "idle");
		assert.equal(snapshot.leafId, "user-1", "the leaf id comes from the public session manager");

		// Compaction (or any session work) is neither idle nor streaming: the browser must
		// not be told it can send.
		session.isIdle = false;
		session.isStreaming = false;
		snapshot = bridge.snapshot();
		assert.equal(snapshot.phase, "unknown");
		assert.equal(snapshot.canSend, false);
		assert.equal(snapshot.canSteer, false);
		bridge.dispose();
	});

	it("keeps per-message revisions stable and exposes incremental snapshots", () => {
		const entries = [userEntry("user-revision", "same", 1)];
		const { bridge } = createBridge({ entries });

		const first = bridge.snapshot();
		const repeated = bridge.snapshot();
		assert.equal(first.messagesFull, true);
		assert.deepEqual(first.historyIds, ["entry:user-revision"]);
		assert.equal(repeated.messages[0].revision, first.messages[0].revision);

		const unchanged = bridge.snapshot({ since: repeated.revision });
		assert.equal(unchanged.messagesFull, false);
		assert.deepEqual(unchanged.messages, []);
		assert.equal(unchanged.historyIds, null);

		const future = bridge.snapshot({ since: repeated.revision + 1 });
		assert.equal(future.messagesFull, true, "a client revision ahead of the host must receive a full snapshot");
		assert.deepEqual(future.messages, first.messages);
		assert.deepEqual(future.historyIds, first.historyIds);

		entries[0].message.content = "changed";
		bridge.refreshFromSession();
		const changed = bridge.snapshot({ since: first.revision });
		assert.equal(changed.messages.length, 1);
		assert.equal(changed.messages[0].text, "changed");
		assert.ok(changed.messages[0].revision > first.messages[0].revision);
		assert.deepEqual(changed.historyIds, ["entry:user-revision"]);
		bridge.dispose();
	});

	it("reconciles streaming events with persisted active-branch history without duplicate rows", () => {
		const entries = [userEntry("user-1", "hello", 1)];
		const { bridge, session } = createBridge({ entries });
		const partial = { role: "assistant", content: [{ type: "text", text: "hel" }], timestamp: 2, stopReason: "pending" };
		bridge.handle({ type: "message_start", message: partial });
		bridge.handle({
			type: "message_update",
			message: { ...partial, content: [{ type: "text", text: "hello from the stream" }] },
			assistantMessageEvent: { type: "text_delta", delta: "lo" },
		});

		let snapshot = bridge.snapshot();
		assert.deepEqual(snapshot.messages.map((message) => message.text), ["hello", "hello from the stream"]);
		assert.equal(snapshot.messages.at(-1).id.startsWith("live:"), true);

		entries.push({
			type: "message",
			id: "assistant-1",
			timestamp: new Date(3).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "hello from the stream" }], timestamp: 2, stopReason: "stop" },
		});
		bridge.handle({ type: "message_end", message: entries.at(-1).message });
		bridge.handle({ type: "agent_end", messages: [] });
		snapshot = bridge.snapshot();
		assert.deepEqual(snapshot.messages.map((message) => message.id), ["entry:user-1", "entry:assistant-1"]);
		assert.deepEqual(snapshot.messages.map((message) => message.text), ["hello", "hello from the stream"]);
		assert.equal(snapshot.messages.length, 2, "finalized streaming content must not duplicate persisted history");
		assert.equal(bridge.snapshot().lastError, null);

		const afterRefresh = bridge.snapshot({ since: snapshot.revision });
		assert.deepEqual(afterRefresh.messages, [], "a refresh without content changes must not bump per-message revisions");
		bridge.dispose();
	});

	it("does not duplicate a canonical tool result when its live lifecycle arrives without refresh", () => {
		const user = { role: "user", content: "run it", timestamp: 1 };
		const assistant = { role: "assistant", content: [{ type: "text", text: "running" }], timestamp: 2, stopReason: "stop" };
		const toolResult = {
			role: "toolResult",
			toolCallId: "call-duplicate",
			toolName: "bash",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 3,
		};
		const entries = [
			{ type: "message", id: "user-1", timestamp: new Date(1).toISOString(), message: user },
			{ type: "message", id: "assistant-2", timestamp: new Date(2).toISOString(), message: assistant },
			{ type: "message", id: "tool-3", timestamp: new Date(3).toISOString(), message: toolResult },
		];
		const { bridge, session } = createBridge({ entries, idle: false });
		session.isIdle = false;
		session.isStreaming = true;

		for (const message of [user, assistant, toolResult]) {
			bridge.handle({ type: "message_start", message });
			bridge.handle({ type: "message_end", message });
		}

		const snapshot = bridge.snapshot();
		assert.deepEqual(snapshot.messages.map((message) => message.id), ["entry:user-1", "entry:assistant-2", "entry:tool-3"]);
		assert.deepEqual(
			snapshot.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
			["call-duplicate"],
		);
		assert.equal(snapshot.messages.filter((message) => message.role === "assistant").length, 1);
		assert.equal(snapshot.messages.filter((message) => message.role === "user").length, 1);
		bridge.dispose();
	});

	it("serializes thinking/tool blocks with redaction and drops unknown provider blocks", () => {
		const { bridge, session } = createBridge({ idle: false });
		session.isIdle = false;
		session.isStreaming = true;
		bridge.handle({
			type: "message_update",
			message: {
				role: "assistant",
				timestamp: 5,
				provider: "private-provider",
				content: [
					{ type: "thinking", thinking: "collapsible reasoning" },
					{ type: "text", text: "visible answer" },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok", apiKey: "do-not-send", note: "Bearer bearer-value" } },
					{ type: "unknown-provider-block", payload: { secret: "do-not-send-either" } },
				],
			},
		});
		const row = bridge.snapshot().messages.at(-1);
		assert.deepEqual(row.blocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
		assert.equal(row.text, "visible answer");
		assert.match(row.blocks[2].arguments, /printf ok/);
		assert.match(row.blocks[2].arguments, /\[redacted\]/);
		assert.match(row.blocks[2].arguments, /Bearer \[redacted\]/);
		assert.equal(row.blocks[2].arguments.includes("do-not-send"), false);
		assert.equal(row.blocks[2].arguments.includes("bearer-value"), false);
		assert.equal(JSON.stringify(row).includes("private-provider"), false);
		assert.equal(JSON.stringify(row).includes("do-not-send-either"), false);
		bridge.dispose();
	});

	it("delivers normal/steer/followUp through the public prompt options and normalizes idle selections", async () => {
		const { bridge, calls, session } = createBridge();
		const sent = await bridge.sendMessage(7, { generation: 7, text: "line one\nline two" });
		assert.deepEqual(sent, {
			ok: true,
			accepted: true,
			queued: false,
			delivery: "normal",
			requestedDelivery: "normal",
			execution: "pending",
			phase: "starting",
		});
		assert.deepEqual(calls.prompts[0], { text: "line one\nline two", options: { expandPromptTemplates: true } });

		const normalized = await bridge.sendMessage(7, { generation: 7, text: "steer while idle", delivery: "steer" });
		assert.equal(normalized.accepted, true);
		assert.equal(normalized.queued, false);
		assert.equal(normalized.delivery, "normal");
		assert.equal(normalized.requestedDelivery, "steer");
		assert.equal(normalized.normalized, true);
		assert.deepEqual(calls.prompts[1].options, { expandPromptTemplates: true }, "idle selections must not send a streaming behaviour");

		session.isIdle = false;
		session.isStreaming = true;
		const steer = await bridge.sendMessage(7, { generation: 7, text: "interrupt", deliverAs: "steer" });
		assert.deepEqual(steer, {
			ok: true,
			accepted: true,
			queued: true,
			delivery: "steer",
			requestedDelivery: "steer",
			execution: "pending",
			phase: "streaming",
		});
		const followUp = await bridge.sendMessage(7, { generation: 7, text: "after", delivery: "followUp" });
		assert.equal(followUp.delivery, "followUp");
		assert.equal(followUp.queued, true);
		assert.equal(followUp.execution, "pending");
		assert.deepEqual(calls.prompts.slice(2).map((call) => call.options), [
			{ expandPromptTemplates: true, streamingBehavior: "steer" },
			{ expandPromptTemplates: true, streamingBehavior: "followUp" },
		]);

		const busy = await bridge.sendMessage(7, { generation: 7, text: "busy normal" });
		assert.equal(busy.code, "busy");
		assert.equal(calls.prompts.length, 4, "busy normal must not reach session.prompt()");

		session.isIdle = false;
		session.isStreaming = false;
		const compacting = await bridge.sendMessage(7, { generation: 7, text: "while compacting", delivery: "steer" });
		assert.equal(compacting.code, "busy");
		assert.match(compacting.message, /compaction/);
		assert.equal(calls.prompts.length, 4, "a session that cannot queue must not receive the message");
		bridge.dispose();
	});

	it("accepts only catalogued extension/prompt/skill slash commands and refuses the rest without prompting", async () => {
		const extensionRunner = { getRegisteredCommands: () => [{ invocationName: "review" }, { invocationName: "review:2" }] };
		const { bridge, calls, session } = createBridge({
			extensionRunner,
			promptTemplates: [{ name: "template" }],
			skills: [{ name: "deep-skill" }],
		});
		for (const text of ["/review files", "/review:2", "/template argument", "/skill:deep-skill read this"]) {
			const result = await bridge.sendMessage(7, { generation: 7, text });
			assert.equal(result.ok, true, text);
		}
		assert.equal(calls.prompts.length, 4);
		assert.deepEqual(calls.prompts.map((call) => call.text), ["/review files", "/review:2", "/template argument", "/skill:deep-skill read this"]);

		for (const text of ["/model gpt", "/unknown", "/", "/ review", " /review", "\n/review", "/\treview"]) {
			const result = await bridge.sendMessage(7, { generation: 7, text });
			assert.equal(result.code, "unsupported_command", text);
		}
		assert.equal(calls.prompts.length, 4, "rejected slash input must never reach session.prompt()");

		// A streaming extension command runs immediately through `prompt()` and is not part of
		// the delivery queue; that is reported as such instead of as a queued message.
		session.isIdle = false;
		session.isStreaming = true;
		const immediate = await bridge.sendMessage(7, { generation: 7, text: "/review now", delivery: "steer" });
		assert.equal(immediate.execution, "immediate");
		assert.equal(immediate.queued, false);
		assert.match(immediate.message, /executed immediately/);
		assert.match(immediate.message, /not part of the delivery queue/);
		assert.deepEqual(calls.prompts.at(-1).options, { expandPromptTemplates: true, streamingBehavior: "steer" });
		bridge.dispose();
	});

	it("refuses slash input as unavailable when the session does not expose its command list", async () => {
		const { bridge, calls } = createBridge();
		const result = await bridge.sendMessage(7, { generation: 7, text: "/review files" });
		assert.equal(result.code, "commands_unavailable");
		assert.equal(result.status, 503);
		assert.match(result.message, /refused instead of being sent to the model/);
		assert.equal(calls.prompts.length, 0);

		const throwing = createBridge({
			extensionRunner: { getRegisteredCommands: () => { throw new Error("runner is invalidated"); } },
		});
		assert.equal((await throwing.bridge.sendMessage(7, { generation: 7, text: "/review" })).code, "commands_unavailable");
		assert.equal(throwing.calls.prompts.length, 0);
		assert.match(throwing.logs.join("\n"), /extension command list unavailable: runner is invalidated/);
		bridge.dispose();
		throwing.bridge.dispose();
	});

	it("delegates stop to session.abort() and refuses stale, malformed and disposed controls", async () => {
		const { bridge, calls } = createBridge();
		assert.deepEqual(await bridge.stop(7, { generation: 7 }), { ok: true, requested: true, phase: "stopping" });
		assert.equal(calls.aborts, 1);
		assert.equal((await bridge.stop(6, { generation: 6 })).code, "stale_generation");
		assert.equal((await bridge.sendMessage(6, { generation: 6, text: "old generation" })).code, "stale_generation");
		assert.equal((await bridge.stop(7, { generation: 7, extra: true })).code, "invalid_body");
		assert.equal((await bridge.sendMessage(7, { generation: 7, text: "hello", extra: true })).code, "invalid_body");
		assert.equal(calls.aborts, 1, "rejected stop bodies must not abort");
		assert.equal(calls.prompts.length, 0, "rejected message bodies must not prompt");

		bridge.dispose();
		assert.equal(calls.unsubscriptions, 1, "dispose must unsubscribe from the session");
		assert.equal(bridge.snapshot().available, false);
		assert.equal((await bridge.stop(7, { generation: 7 })).code, "stale_generation");
		assert.equal(calls.aborts, 1, "a disposed chat must not abort a released session");
	});

	it("keeps asynchronous prompt failures and observable command failures visible in lastError", async () => {
		const errorListeners = [];
		const extensionRunner = {
			getRegisteredCommands: () => [{ invocationName: "explode" }],
			onError(listener) {
				errorListeners.push(listener);
				return () => {};
			},
		};
		const entries = [];
		const { bridge } = createBridge({
			entries,
			extensionRunner,
			prompt: () => Promise.reject(new Error("no API key for provider-x")),
		});
		const accepted = await bridge.sendMessage(7, { generation: 7, text: "hello" });
		assert.equal(accepted.accepted, true, "acceptance is reported before the asynchronous outcome is known");
		await waitForImmediate();
		assert.match(bridge.snapshot().lastError, /message delivery failed after acceptance: no API key for provider-x/);

		errorListeners[0]({ event: "command", error: "extension command blew up" });
		assert.match(bridge.snapshot().lastError, /slash command failed: extension command blew up/);
		errorListeners[0]({ event: "send_user_message", error: "unrelated extension message failure" });
		assert.match(
			bridge.snapshot().lastError,
			/slash command failed: extension command blew up/,
			"unrelated extension errors must not replace the browser-visible chat error",
		);

		entries.push(userEntry("user-1", "hello", 1));
		bridge.handle({ type: "agent_end", messages: [] });
		const recovered = bridge.snapshot();
		assert.equal(recovered.lastError, null, "a successful canonical refresh clears the previous error");
		assert.deepEqual(recovered.messages.map((message) => message.text), ["hello"]);
		bridge.dispose();
	});

	it("refuses to build without a usable session and surfaces history failures without inventing rows", () => {
		assert.throws(() => new HostChatBridge({ session: { prompt: () => {}, abort: () => {} }, generation: 1 }), /requires an AgentSession with prompt\(\), abort\(\) and subscribe\(\)/);
		assert.throws(
			() => new HostChatBridge({ session: { prompt: () => {}, abort: () => {}, subscribe: () => () => {}, sessionManager: {} }, generation: 1 }),
			/requires session.sessionManager.buildContextEntries\(\)/,
		);
		assert.throws(
			() => new HostChatBridge({ session: { prompt: () => {}, abort: () => {}, subscribe: () => () => {}, sessionManager: { buildContextEntries: () => [] } }, generation: 0 }),
			/positive integer binding generation/,
		);

		const { bridge } = createBridge();
		bridge.dispose();
		const broken = createBridge();
		broken.session.sessionManager.buildContextEntries = () => {
			throw new Error("history is unavailable");
		};
		broken.bridge.refreshFromSession();
		const snapshot = broken.bridge.snapshot();
		assert.equal(snapshot.lastError, "current session history is temporarily unavailable");
		assert.deepEqual(snapshot.messages, [], "no history row may be fabricated");
		assert.match(broken.logs.join("\n"), /browser chat history unavailable: history is unavailable/);
		broken.bridge.dispose();
	});
});
