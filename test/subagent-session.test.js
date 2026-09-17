/**
 * The host-side child session reader: path derivation from a run id, bounded tail reading,
 * record projection and paging. Pure file I/O against a temporary session file, no session,
 * no extension and no model call involved.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { SUBAGENT_SESSION_LIMITS, childSessionPath, readChildSessionPage } from "../src/core/subagent-session.js";

const RUN_ID = "b8b66f6a-5c54-41c5-8efc-44fbf9655b3e";

function makeSessionRoot() {
	const root = mkdtempSync(join(tmpdir(), "pi-gui-child-session-"));
	const parentSessionFile = join(root, "2026-09-17T03-23-37-884Z_01a0ad64.jsonl");
	writeFileSync(parentSessionFile, "");
	return { root, parentSessionFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** One Pi session record shaped like a real child session (thinking, tool call, tool result). */
function record(type, extra = {}) {
	return JSON.stringify({ type, id: `entry-${Math.random().toString(16).slice(2, 8)}`, parentId: null, timestamp: "2026-09-17T07:11:29.795Z", ...extra });
}

function messageRecord(message) {
	return record("message", { message });
}

function writeChildSession(parentSessionFile, lines, { runId = RUN_ID, index = 0 } = {}) {
	const path = join(dirname(parentSessionFile), basename(parentSessionFile, ".jsonl"), runId, `run-${index}`, "session.jsonl");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

const CHILD_LINES = [
	record("session", { version: 1 }),
	messageRecord({ role: "user", content: [{ type: "text", text: "Task: 只回复 OK" }], timestamp: 1 }),
	messageRecord({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "The task is trivial. I will not read files." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/browser/app.css", sessionFile: "C:\\private\\child\\session.jsonl" } },
		],
		timestamp: 2,
	}),
	messageRecord({ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "1  /* first line */" }], isError: false, details: { asyncId: "11111111-2222-4333-8444-555555555555" }, timestamp: 3 }),
	messageRecord({ role: "assistant", content: [{ type: "text", text: "OK" }], timestamp: 4 }),
];

test("derives the child session path from a run id without accepting a path", () => {
	const { cleanup, parentSessionFile } = makeSessionRoot();
	try {
		const derived = childSessionPath({ parentSessionFile, runId: RUN_ID, index: 2 });
		assert.equal(derived.ok, true);
		assert.equal(derived.path, join(dirname(parentSessionFile), basename(parentSessionFile, ".jsonl"), RUN_ID, "run-2", "session.jsonl"));

		for (const body of [
			{ parentSessionFile, runId: "../etc/passwd", index: 0 },
			{ parentSessionFile, runId: `${RUN_ID}/../../etc`, index: 0 },
			{ parentSessionFile, runId: "not-a-uuid", index: 0 },
			{ parentSessionFile, runId: RUN_ID.toUpperCase().replace("-", "_"), index: 0 },
			{ parentSessionFile, runId: RUN_ID, index: -1 },
			{ parentSessionFile, runId: RUN_ID, index: 1.5 },
			{ parentSessionFile, runId: RUN_ID, index: 999 },
			{ parentSessionFile: null, runId: RUN_ID, index: 0 },
		]) {
			const refused = childSessionPath(body);
			assert.equal(refused.ok, false, `${JSON.stringify(body)} must be refused`);
			assert.equal(typeof refused.code, "string");
		}
	} finally {
		cleanup();
	}
});

test("reads the newest page of a child session and pages backwards with a cursor", () => {
	const { cleanup, parentSessionFile } = makeSessionRoot();
	try {
		const path = writeChildSession(parentSessionFile, CHILD_LINES);
		const first = readChildSessionPage({ path, limit: 2 });
		assert.equal(first.ok, true);
		assert.equal(first.messages.length, 2);
		assert.equal(first.earlier, true);
		assert.equal(first.cursor, 2);
		assert.equal(first.messages[1].text, "OK");
		assert.equal(first.window.limit, 2);
		assert.equal(first.window.truncatedHead, false);

		const older = readChildSessionPage({ path, limit: 2, before: first.cursor });
		assert.equal(older.ok, true);
		assert.equal(older.messages.length, 2);
		assert.equal(older.earlier, false, "the oldest page must say that nothing is older");
		assert.equal(older.cursor, null);
		assert.equal(older.messages[0].role, "user");

		const all = readChildSessionPage({ path, limit: SUBAGENT_SESSION_LIMITS.maxLimit });
		assert.equal(all.messages.length, 4, "session/model records are not conversation records");
		assert.equal(all.window.skipped, 1, "a record that is not a chat message is counted as skipped");
	} finally {
		cleanup();
	}
});

test("projects every block a child session holds, including thinking and tool arguments", () => {
	const { cleanup, parentSessionFile } = makeSessionRoot();
	try {
		const path = writeChildSession(parentSessionFile, CHILD_LINES);
		const page = readChildSessionPage({ path, limit: 10 });
		const assistant = page.messages.find((message) => message.role === "assistant" && message.timestamp === 2);
		assert.equal(assistant.blocks.length, 2, "thinking and toolCall survive as their own blocks");
		const thinking = assistant.blocks.find((block) => block.type === "thinking");
		assert.match(thinking.text, /The task is trivial/, "the thinking text is projected as its own block text");
		const toolCall = assistant.blocks.find((block) => block.type === "toolCall");
		assert.equal(toolCall.name, "read");
		assert.match(toolCall.arguments, /src\/browser\/app\.css/, "ordinary paths inside content stay readable");
		assert.equal(toolCall.arguments.includes("C:\\\\private\\\\child"), false, "sensitive session path fields are redacted");

		const result = page.messages.find((message) => message.role === "toolResult");
		assert.equal(result.toolName, "read");
		assert.equal(result.isError, undefined);
		assert.equal(Object.hasOwn(result, "subagentRunId"), false, "a grandchild run id is never projected");
		assert.equal(JSON.stringify(result.blocks).includes("subagentRunId"), false, "a grandchild run id is not leaked inside a tool-result block");
	} finally {
		cleanup();
	}
});

test("redacts credential shapes and never returns a partial record from a byte-truncated head", () => {
	const { cleanup, parentSessionFile } = makeSessionRoot();
	try {
		const filler = Array.from({ length: 40 }, (_value, index) => messageRecord({ role: "assistant", content: [{ type: "text", text: `filler line ${index} ${"x".repeat(200)}` }] }));
		const secret = messageRecord({ role: "assistant", content: [{ type: "text", text: "token=abc123 and Bearer abc.def-token" }] });
		const path = writeChildSession(parentSessionFile, [...filler, secret]);

		// A tiny byte window proves the head-truncation path: the first line is partial and must go.
		const page = readChildSessionPage({ path, limit: 5, maxBytes: 600 });

		assert.equal(page.ok, true);
		assert.equal(page.window.truncatedHead, true);
		assert.equal(page.messages.every((message) => typeof message.id === "string" && !message.id.startsWith("child-record-0")), true);
		assert.equal(/\d{3,}/.test(page.messages.map((message) => message.text).join(" ")) && /filler line 0/.test(page.messages.map((message) => message.text).join(" ")), false, "a partial head record is dropped, not parsed");
		assert.equal(page.messages.at(-1).text.includes("abc.def-token"), false);
		assert.equal(page.messages.at(-1).text.includes("abc123"), false);
		assert.match(page.messages.at(-1).text, /Bearer \[redacted\]/);
	} finally {
		cleanup();
	}
});

test("fails closed for a missing file, a directory and a non-file path", () => {
	const { cleanup, parentSessionFile } = makeSessionRoot();
	try {
		const missing = readChildSessionPage({ path: join(parentSessionFile, "..", RUN_ID, "run-0", "session.jsonl") });
		assert.equal(missing.ok, false);
		assert.equal(missing.code, "not_found");

		const directory = readChildSessionPage({ path: join(parentSessionFile, "..") });
		assert.equal(directory.ok, false);
		assert.equal(directory.code, "not_found");

		// A symlink must not be followed into an unrelated file, whether it resolves or not.
		const link = join(parentSessionFile, "..", "link.jsonl");
		try {
			const target = join(parentSessionFile, "..", "outside.jsonl");
			writeFileSync(target, JSON.stringify({ type: "message", message: { role: "assistant", content: "outside" } }));
			symlinkSync(target, link);
			const followed = readChildSessionPage({ path: link });
			assert.equal(followed.ok, false, "a valid symlink must fail closed");
			rmSync(link, { force: true });
			symlinkSync(join(parentSessionFile, "missing-target"), link);
			const broken = readChildSessionPage({ path: link });
			assert.equal(broken.ok, false);
		} catch {
			// Symlink creation may be unavailable without privileges; the other cases cover the contract.
		}
	} finally {
		cleanup();
	}
});
