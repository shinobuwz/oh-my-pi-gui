import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHAT_LIMITS, ChatBridge } from "../src/adapter/chat-bridge.js";

function makeContext(entries, { idle = true } = {}) {
	const calls = { abort: 0 };
	const ctx = {
		sessionManager: {
			buildContextEntries: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
		},
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort: () => {
			calls.abort += 1;
		},
	};
	return { ctx, calls };
}

function makePi(ctx, calls, commands = [{ name: "review", source: "extension" }]) {
	return {
		getCommands: () => commands,
		sendUserMessage: (text, options) => calls.push({ text, options }),
	};
}

describe("generation-scoped chat bridge", () => {
	it("keeps per-message revisions stable and exposes incremental snapshots", () => {
		const entries = [
			{
				type: "message",
				id: "user-revision",
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "same", timestamp: 1 },
			},
		];
		const { ctx } = makeContext(entries);
		const bridge = new ChatBridge({ pi: makePi(ctx, []), ctx, generation: 2 });

		const first = bridge.snapshot();
		const repeated = bridge.snapshot();
		assert.equal(first.messagesFull, true);
		assert.equal(first.historyIds.length, 1);
		assert.equal(repeated.messages[0].revision, first.messages[0].revision);

		const unchanged = bridge.snapshot({ since: repeated.revision });
		assert.equal(unchanged.messagesFull, false);
		assert.deepEqual(unchanged.messages, []);
		assert.equal(unchanged.historyIds, null);

		const future = bridge.snapshot({ since: repeated.revision + 1 });
		assert.equal(future.messagesFull, true, "a client revision ahead of the bridge must receive a full snapshot");
		assert.deepEqual(future.messages, first.messages);
		assert.deepEqual(future.historyIds, first.historyIds);

		entries[0].message.content = "changed";
		bridge.refreshFromSession();
		const changed = bridge.snapshot({ since: first.revision });
		assert.equal(changed.messages.length, 1);
		assert.ok(changed.messages[0].revision > first.messages[0].revision);
		assert.equal(changed.messages[0].text, "changed");
		assert.deepEqual(changed.historyIds, ["entry:user-revision"]);
	});

	it("reconciles incremental assistant events with persisted active-branch history", () => {
		const entries = [
			{
				type: "message",
				id: "user-1",
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
		];
		const { ctx } = makeContext(entries);
		const bridge = new ChatBridge({ pi: makePi(ctx, []), ctx, generation: 3 });
		const partial = { role: "assistant", content: [{ type: "text", text: "hel" }], timestamp: 2, stopReason: "pending" };
		bridge.handle({ type: "message_start", message: partial }, ctx);
		bridge.handle({
			type: "message_update",
			message: { ...partial, content: [{ type: "text", text: "hello from the stream" }] },
			assistantMessageEvent: { type: "text_delta", delta: "lo" },
		}, ctx);

		let snapshot = bridge.snapshot();
		assert.deepEqual(snapshot.messages.map((message) => message.text), ["hello", "hello from the stream"]);
		assert.equal(snapshot.messages.at(-1).id.startsWith("live:"), true);

		entries.push({
			type: "message",
			id: "assistant-1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "hello from the stream" }], timestamp: 2, stopReason: "stop" },
		});
		bridge.handle({ type: "message_end", message: entries.at(-1).message }, ctx);
		bridge.handle({ type: "agent_end", messages: [] }, ctx);
		snapshot = bridge.snapshot();
		assert.deepEqual(snapshot.messages.map((message) => message.id), ["entry:user-1", "entry:assistant-1"]);
		assert.deepEqual(snapshot.messages.map((message) => message.text), ["hello", "hello from the stream"]);
		assert.equal(snapshot.messages.length, 2, "finalized streaming content must not duplicate persisted history");
	});

	it("sends only idle normal messages, expands supported commands, and rejects busy/unknown routes", async () => {
		const entries = [];
		const { ctx } = makeContext(entries);
		const calls = [];
		const pi = makePi(ctx, calls);
		const bridge = new ChatBridge({ pi, ctx, generation: 4 });

		const sent = await bridge.sendMessage(4, { generation: 4, text: "line one\nline two" });
		assert.deepEqual(sent, {
			ok: true,
			accepted: true,
			queued: false,
			delivery: "normal",
			requestedDelivery: "normal",
			execution: "pending",
			phase: "starting",
		});
		assert.deepEqual(calls[0], { text: "line one\nline two", options: { expandPromptTemplates: true } });

		assert.equal((await bridge.sendMessage(4, { generation: 4, text: "/review files" })).ok, true);
		assert.equal((await bridge.sendMessage(4, { generation: 4, text: "/model gpt" })).code, "unsupported_command");
		assert.equal((await bridge.sendMessage(4, { generation: 4, text: "not yet", deliverAs: "unknown" })).code, "unsupported_delivery");
		assert.equal((await bridge.sendMessage(4, { generation: 4, text: " /unknown" })).code, "unsupported_command");

		const busy = makeContext(entries, { idle: false });
		bridge.handle({ type: "agent_start" }, busy.ctx);
		const rejected = await bridge.sendMessage(4, { generation: 4, text: "busy" });
		assert.equal(rejected.code, "busy");
		const steer = await bridge.sendMessage(4, { generation: 4, text: "interrupt", delivery: "steer" });
		assert.deepEqual(steer, {
			ok: true,
			accepted: true,
			queued: true,
			delivery: "steer",
			requestedDelivery: "steer",
			execution: "pending",
			phase: "streaming",
		});
		const followUp = await bridge.sendMessage(4, { generation: 4, text: "after", deliverAs: "followUp" });
		assert.equal(followUp.delivery, "followUp");
		assert.equal(followUp.queued, true);
		assert.equal(followUp.execution, "pending");
		assert.deepEqual(calls.slice(2), [
			{ text: "interrupt", options: { deliverAs: "steer", expandPromptTemplates: true } },
			{ text: "after", options: { deliverAs: "followUp", expandPromptTemplates: true } },
		]);
		assert.equal(calls.length, 4, "busy normal must not reach pi.sendUserMessage");
	});

	it("distinguishes immediate extension slash commands from queued prompt commands while streaming", async () => {
		const entries = [];
		const { ctx } = makeContext(entries, { idle: false });
		const calls = [];
		const commands = [
			{ name: "extension-command", source: "extension" },
			{ name: "prompt-command", source: "prompt" },
		];
		const bridge = new ChatBridge({ pi: makePi(ctx, calls, commands), ctx, generation: 16 });

		const extension = await bridge.sendMessage(16, { generation: 16, text: "/extension-command now", delivery: "steer" });
		assert.equal(extension.execution, "immediate");
		assert.equal(extension.queued, false);
		assert.match(extension.message, /executed immediately/i);
		assert.match(extension.message, /not part of the delivery queue/i);

		const prompt = await bridge.sendMessage(16, { generation: 16, text: "/prompt-command later", delivery: "followUp" });
		assert.equal(prompt.execution, "pending");
		assert.equal(prompt.queued, true);
		assert.equal(Object.hasOwn(prompt, "message"), false);
		assert.deepEqual(calls.map(({ options }) => options), [
			{ deliverAs: "steer", expandPromptTemplates: true },
			{ deliverAs: "followUp", expandPromptTemplates: true },
		]);
	});

	it("rejects built-in, malformed, unknown, empty and whitespace-prefixed slash commands without sending model text", async () => {
		const { ctx } = makeContext([]);
		const calls = [];
		const commands = [
			{ name: "model", source: "builtin" },
			{ name: "review" },
			{ source: "extension" },
			null,
		];
		const bridge = new ChatBridge({ pi: makePi(ctx, calls, commands), ctx, generation: 5 });

		for (const text of ["/model", "/review", "/unknown", "/", "/ review", "/\treview", " /review", "\n/review"]) {
			const result = await bridge.sendMessage(5, { generation: 5, text });
			assert.equal(result.code, "unsupported_command", text);
		}
		assert.equal(calls.length, 0, "rejected slash input must never reach sendUserMessage");
	});

	it("accepts only current extension, prompt and skill command descriptors and expands templates", async () => {
		const { ctx } = makeContext([]);
		const calls = [];
		const commands = [
			{ name: "extension-command", source: "extension", sourceInfo: { path: "extension.js" } },
			{ name: "prompt-command", source: "prompt", sourceInfo: { path: "prompt.md" } },
			{ name: "skill-command", source: "skill", sourceInfo: { path: "skill.md" } },
		];
		const bridge = new ChatBridge({ pi: makePi(ctx, calls, commands), ctx, generation: 6 });

		for (const name of ["extension-command", "prompt-command", "skill-command"]) {
			const result = await bridge.sendMessage(6, { generation: 6, text: `/${name} argument` });
			assert.equal(result.ok, true);
		}
		assert.deepEqual(calls, [
			{ text: "/extension-command argument", options: { expandPromptTemplates: true } },
			{ text: "/prompt-command argument", options: { expandPromptTemplates: true } },
			{ text: "/skill-command argument", options: { expandPromptTemplates: true } },
		]);
	});

	it("rejects extra message and stop fields before invoking Pi actions", async () => {
		const { ctx, calls: contextCalls } = makeContext([]);
		const calls = [];
		const bridge = new ChatBridge({ pi: makePi(ctx, calls), ctx, generation: 10 });

		assert.equal((await bridge.sendMessage(10, { generation: 10, text: "hello", extra: true })).code, "invalid_body");
		assert.equal((await bridge.stop(10, { generation: 10, extra: true })).code, "invalid_body");
		assert.equal(calls.length, 0, "invalid action bodies must not invoke Pi");
		assert.equal(contextCalls.abort, 0);
	});

	it("normalizes idle steer/followUp selections without claiming queued delivery", async () => {
		const { ctx } = makeContext([]);
		const calls = [];
		const bridge = new ChatBridge({ pi: makePi(ctx, calls), ctx, generation: 8 });

		for (const delivery of ["steer", "followUp"]) {
			const result = await bridge.sendMessage(8, { generation: 8, text: `${delivery} while idle`, delivery });
			assert.equal(result.accepted, true);
			assert.equal(result.queued, false);
			assert.equal(result.delivery, "normal");
			assert.equal(result.requestedDelivery, delivery);
			assert.equal(result.normalized, true);
			assert.equal(result.execution, "pending");
		}
		assert.deepEqual(calls.map(({ options }) => options), [
			{ expandPromptTemplates: true },
			{ expandPromptTemplates: true },
		]);
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
			{ type: "message", id: "user-1", timestamp: "2026-01-01T00:00:01.000Z", message: user },
			{ type: "message", id: "assistant-2", timestamp: "2026-01-01T00:00:02.000Z", message: assistant },
			{ type: "message", id: "tool-3", timestamp: "2026-01-01T00:00:03.000Z", message: toolResult },
		];
		const { ctx } = makeContext(entries, { idle: false });
		const bridge = new ChatBridge({ pi: makePi(ctx, []), ctx, generation: 17 });

		for (const message of [user, assistant, toolResult]) {
			bridge.handle({ type: "message_start", message }, ctx);
			bridge.handle({ type: "message_end", message }, ctx);
		}

		const snapshot = bridge.snapshot();
		assert.deepEqual(snapshot.messages.map((message) => message.id), ["entry:user-1", "entry:assistant-2", "entry:tool-3"]);
		assert.deepEqual(snapshot.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId), ["call-duplicate"]);
		assert.equal(snapshot.messages.filter((message) => message.role === "assistant").length, 1);
		assert.equal(snapshot.messages.filter((message) => message.role === "user").length, 1);
	});

	it("serializes thinking, tool blocks and bounded tool execution without exposing provider data", async () => {
		const entries = [];
		const { ctx } = makeContext(entries, { idle: false });
		const calls = [];
		const bridge = new ChatBridge({ pi: makePi(ctx, calls), ctx, generation: 9 });
		const assistant = {
			role: "assistant",
			timestamp: 10,
			provider: "private-provider",
			api: "private-api",
			usage: { cost: 42 },
			content: [
				{ type: "thinking", thinking: "reasoning that should be separately collapsible" },
				{ type: "text", text: "visible answer" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok", apiKey: "do-not-send", nested: { token: "also-redacted" }, note: "Bearer bearer-value", config: "secret=assignment-value", path: "/workspace/project/file.txt" } },
			],
		};
		bridge.handle({ type: "message_start", message: assistant }, ctx);
		let snapshot = bridge.snapshot();
		const assistantRow = snapshot.messages.at(-1);
		assert.deepEqual(assistantRow.blocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
		assert.equal(assistantRow.text, "visible answer");
		assert.match(assistantRow.blocks[0].text, /separately collapsible/);
		assert.match(assistantRow.blocks[2].arguments, /printf ok/);
		assert.match(assistantRow.blocks[2].arguments, /\[redacted\]/);
		assert.match(assistantRow.blocks[2].arguments, /Bearer \[redacted\]/);
		assert.match(assistantRow.blocks[2].arguments, /secret=\[redacted\]/);
		assert.match(assistantRow.blocks[2].arguments, /workspace\/project\/file\.txt/);
		assert.equal(assistantRow.blocks[2].arguments.includes("bearer-value"), false);
		assert.equal(assistantRow.blocks[2].arguments.includes("assignment-value"), false);
		assert.equal(assistantRow.blocks[2].arguments.includes("private-provider"), false);
		assert.equal(JSON.stringify(assistantRow).includes("usage"), false);
		assert.equal(assistantRow.blocks[0].text.length <= CHAT_LIMITS.maxBlockTextChars, true);
		assert.equal(assistantRow.blocks[2].arguments.length <= CHAT_LIMITS.maxToolArgumentChars, true);

		bridge.handle({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "printf ok", apiKey: "secret" } }, ctx);
		bridge.handle({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "printf ok" },
			partialResult: { content: [{ type: "text", text: "partial output" }], details: { private: "omit" } },
		}, ctx);
		snapshot = bridge.snapshot();
		const liveTool = snapshot.messages.at(-1);
		assert.equal(liveTool.kind, "tool_execution");
		assert.equal(liveTool.blocks[1].content, "partial output");
		bridge.handle({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "final output" }], details: { private: "omit" } },
			isError: false,
		}, ctx);
		assert.equal(bridge.snapshot().messages.at(-1).status, "complete");

		const toolResult = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "final output" }],
			isError: false,
			timestamp: 11,
		};
		entries.push({ type: "message", id: "assistant-10", timestamp: "2026-01-01T00:00:10.000Z", message: assistant });
		entries.push({ type: "message", id: "tool-11", timestamp: "2026-01-01T00:00:11.000Z", message: toolResult });
		bridge.handle({ type: "message_end", message: assistant }, ctx);
		bridge.handle({ type: "message_end", message: toolResult }, ctx);
		bridge.handle({ type: "agent_end" }, ctx);
		snapshot = bridge.snapshot();
		assert.deepEqual(snapshot.messages.map((message) => message.id), ["entry:assistant-10", "entry:tool-11"]);
		assert.equal(snapshot.messages.filter((message) => message.toolCallId === "call-1").length, 1, "final tool result must replace its live execution row");
		assert.equal(JSON.stringify(snapshot).includes("private-provider"), false);
		assert.equal(JSON.stringify(snapshot).includes("do-not-send"), false);
	});

	it("delegates stop to the current ctx and refuses stale generations", async () => {
		const entries = [];
		const first = makeContext(entries, { idle: false });
		const calls = [];
		const bridge = new ChatBridge({ pi: makePi(first.ctx, calls), ctx: first.ctx, generation: 7 });
		assert.deepEqual(await bridge.stop(7, { generation: 7 }), { ok: true, requested: true, phase: "stopping" });
		assert.equal(first.calls.abort, 1);
		assert.equal((await bridge.stop(6, { generation: 6 })).code, "stale_generation");
		bridge.dispose();
		assert.equal((await bridge.stop(7, { generation: 7 })).code, "stale_generation");
		assert.equal(first.calls.abort, 1, "disposed chat controls must not call the old ctx");
	});
});
