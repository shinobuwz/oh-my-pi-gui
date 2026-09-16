/**
 * Structured pi-subagents inspect reply: the pure parser and the bounded projection.
 *
 * These tests pin the two properties the host relies on: a payload is either accepted and
 * re-bounded (never trusted as-is), or rejected with a stable reason — and nothing that
 * looks like a credential or a host path field survives the projection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	INSPECT_LIMITS,
	INSPECT_PAYLOAD_PREFIX,
	INSPECT_REPLY_KIND,
	INSPECT_REPLY_VERSION,
	INSPECT_WIDGET_KEY,
	boundedInspectLines,
	inspectPayloadLines,
	isValidInspectRequestId,
	parseInspectWidgetLine,
	projectInspectReply,
} from "../src/core/inspect-reply.js";

function payload(reply) {
	return `${INSPECT_PAYLOAD_PREFIX}${JSON.stringify(reply)}`;
}

function reply(overrides = {}) {
	return {
		kind: INSPECT_REPLY_KIND,
		version: INSPECT_REPLY_VERSION,
		requestId: "req-1",
		...overrides,
	};
}

/** The shape pi-subagents 0.67.0 answers with for one running async run. */
function successReply(overrides = {}) {
	return reply({
		asyncId: "async-real-id",
		childId: "child-id",
		status: "running",
		label: "Review",
		task: "Review the bounded change\nsecond line",
		messages: [
			{ role: "user", kind: "text", text: "Review the bounded change" },
			{ role: "assistant", kind: "toolCall", text: '{"path":"src/x.js"}', name: "read" },
			{ role: "toolResult", kind: "toolResult", text: "file body", name: "read", isError: true },
			{ role: "assistant", kind: "text", text: "done" },
		],
		finalOutput: "final answer",
		...overrides,
	});
}

describe("inspect payload parsing", () => {
	it("accepts exactly the host protocol envelope", () => {
		assert.equal(INSPECT_WIDGET_KEY, "subagent-inspect");
		assert.equal(INSPECT_PAYLOAD_PREFIX, "PI_SUBAGENT_INSPECT_JSON:");
		const parsed = parseInspectWidgetLine(payload(successReply()));
		assert.equal(parsed.ok, true);
		assert.equal(parsed.reply.requestId, "req-1");
		assert.equal(isValidInspectRequestId("req-1_ABC"), true);
		assert.equal(isValidInspectRequestId("bad id"), false);
		assert.equal(isValidInspectRequestId(""), false);
		assert.equal(isValidInspectRequestId("x".repeat(65)), false);
		assert.equal(isValidInspectRequestId(42), false);
	});

	it("rejects a missing, foreign, malformed or differently versioned payload", () => {
		assert.equal(parseInspectWidgetLine(undefined).reason, "empty_payload");
		assert.equal(parseInspectWidgetLine("").reason, "empty_payload");
		assert.equal(parseInspectWidgetLine("ordinary widget line").reason, "not_inspect_payload");
		assert.equal(parseInspectWidgetLine(`${INSPECT_PAYLOAD_PREFIX}{`).reason, "malformed_json");
		assert.equal(parseInspectWidgetLine(`${INSPECT_PAYLOAD_PREFIX}[1,2]`).reason, "malformed_reply");
		assert.equal(parseInspectWidgetLine(payload(reply({ kind: "other.reply" }))).reason, "unexpected_kind");
		assert.equal(parseInspectWidgetLine(payload(reply({ version: 2 }))).reason, "unsupported_version");
		assert.equal(parseInspectWidgetLine(payload(reply({ requestId: "bad id" }))).reason, "invalid_request_id");
		assert.equal(parseInspectWidgetLine(payload(reply({ requestId: undefined }))).reason, "invalid_request_id");
	});

	it("finds the payload inside the widget line array and stays bounded", () => {
		assert.equal(parseInspectWidgetLine([`${INSPECT_PAYLOAD_PREFIX}${JSON.stringify(reply())}`]).ok, true);
		const lines = Array.from({ length: 20 }, (_value, index) => `PI_SUBAGENT_INSPECT_JSON:${JSON.stringify(reply({ requestId: `r-${index}` }))}`);
		lines.unshift("a plain widget line", 42);
		assert.equal(inspectPayloadLines(lines).length, 8, "the payload list is bounded");
		assert.equal(inspectPayloadLines(lines, { maxLines: 2 }).length, 2);
		assert.deepEqual(inspectPayloadLines("not an array"), []);
		assert.deepEqual(inspectPayloadLines(["no payload here"]), []);
	});

	it("accepts only the line counts the extension accepts", () => {
		assert.equal(boundedInspectLines(1), 1);
		assert.equal(boundedInspectLines(200), 200);
		assert.equal(boundedInspectLines(0), undefined);
		assert.equal(boundedInspectLines(201), undefined);
		assert.equal(boundedInspectLines(10.5), undefined);
		assert.equal(boundedInspectLines("10"), undefined);
		assert.equal(boundedInspectLines(undefined), undefined);
		assert.equal(INSPECT_LIMITS.maxLines, 200, "the line bound matches the extension's own maximum");
		assert.equal(INSPECT_LIMITS.defaultLines, 100, "the default line count matches the extension's default");
	});
});

describe("inspect reply projection", () => {
	it("projects the documented fields, keeps tool calls distinct and drops everything else", () => {
		const parsed = parseInspectWidgetLine(payload(successReply({
			asyncDir: "C:\\private\\run",
			sessionFile: "C:\\private\\session.jsonl",
			unknownField: "must not cross the boundary",
		})));
		assert.equal(parsed.ok, true);
		const projected = projectInspectReply(parsed.reply, { requestId: "req-1" });
		assert.equal(projected.ok, true);
		const inspect = projected.inspect;
		assert.deepEqual(Object.keys(inspect).sort(), ["asyncId", "childId", "finalOutput", "label", "messages", "status", "task", "truncated"]);
		assert.equal(inspect.asyncId, "async-real-id");
		assert.equal(inspect.childId, "child-id");
		assert.equal(inspect.status, "running");
		assert.equal(inspect.label, "Review");
		assert.equal(inspect.task, "Review the bounded change\nsecond line");
		assert.equal(inspect.finalOutput, "final answer");
		assert.deepEqual(inspect.truncated, { task: false, messages: 0, finalOutput: false });
		assert.equal(inspect.messages.length, 4);
		assert.deepEqual(inspect.messages[1], { role: "assistant", kind: "toolCall", text: '{"path":"src/x.js"}', name: "read" });
		assert.deepEqual(inspect.messages[2], { role: "toolResult", kind: "toolResult", text: "file body", name: "read", isError: true });
		assert.equal(inspect.messages[0].isError, undefined, "a result is only flagged when the extension flags it");
		const serialized = JSON.stringify(inspect);
		assert.equal(serialized.includes("private"), false, "no host path field may survive");
		assert.equal(serialized.includes("unknownField"), false);
		assert.equal(serialized.includes("asyncDir"), false);
	});

	it("correlates by request id and refuses a mismatched or malformed reply", () => {
		assert.equal(projectInspectReply(successReply(), { requestId: "req-1" }).ok, true);
		const mismatched = projectInspectReply(successReply(), { requestId: "req-2" });
		assert.equal(mismatched.ok, false);
		assert.equal(mismatched.reason, "request_id_mismatch");
		assert.equal(projectInspectReply(null).reason, "malformed_reply");
		assert.equal(projectInspectReply(reply({ kind: "nope" })).reason, "unexpected_kind");
		assert.equal(projectInspectReply(reply({ version: 3 })).reason, "unsupported_version");
		assert.equal(projectInspectReply(reply({ requestId: "bad id" })).reason, "invalid_request_id");
	});

	it("re-bounds messages, text, task and final output, and reports what was dropped", () => {
		const long = "x".repeat(5000);
		const veryLong = "y".repeat(20_000);
		const messages = Array.from({ length: 260 }, (_value, index) => ({
			role: "assistant",
			kind: index % 3 === 0 ? "toolCall" : index % 3 === 1 ? "toolResult" : "text",
			text: long,
			name: `tool-${index}`,
		}));
		// Two entries are structurally unusable and must be dropped, never rendered.
		messages.push({ role: "assistant", kind: "unknownKind", text: "nope" }, { role: "assistant" });
		const projected = projectInspectReply(reply({
			task: long,
			finalOutput: veryLong,
			messages,
			truncated: { task: true, messages: 4, finalOutput: true },
		}));
		assert.equal(projected.ok, true);
		const inspect = projected.inspect;
		assert.equal(inspect.messages.length, INSPECT_LIMITS.maxMessages);
		assert.equal(inspect.messages.every((message) => message.text.length <= INSPECT_LIMITS.maxMessageChars), true);
		assert.equal(inspect.messages[0].text.endsWith("…"), true, "a cut value is visibly marked");
		assert.equal(inspect.task.length, INSPECT_LIMITS.maxTaskChars);
		assert.equal(inspect.finalOutput.length, INSPECT_LIMITS.maxFinalOutputChars);
		assert.deepEqual(
			inspect.truncated,
			{ task: true, messages: 66, finalOutput: true },
			"the extension's own drop count and this projection's drops are reported together",
		);
		assert.equal(
			JSON.stringify(inspect).includes(long),
			false,
			"the projection never carries an unbounded value",
		);
		assert.equal(JSON.stringify(inspect).includes(veryLong), false);
	});

	it("normalizes a missing or nonsensical truncated report instead of forwarding it", () => {
		assert.deepEqual(projectInspectReply(reply({ messages: [] })).inspect.truncated, { task: false, messages: 0, finalOutput: false });
		assert.deepEqual(
			projectInspectReply(reply({ messages: [], truncated: { task: "yes", messages: -3, finalOutput: 1 } })).inspect.truncated,
			{ task: false, messages: 0, finalOutput: false },
		);
		assert.deepEqual(
			projectInspectReply(reply({ messages: [], truncated: { messages: 7 } })).inspect.truncated,
			{ task: false, messages: 7, finalOutput: false },
		);
	});

	it("omits absent optional fields and keeps an empty message list", () => {
		const projected = projectInspectReply(reply({ asyncId: "async-real-id", status: "completed" }));
		assert.equal(projected.ok, true);
		assert.deepEqual(projected.inspect, {
			asyncId: "async-real-id",
			status: "completed",
			messages: [],
			truncated: { task: false, messages: 0, finalOutput: false },
		});
		const namedOnly = projectInspectReply(reply({ messages: [{ role: "assistant", kind: "toolCall", name: "read" }] }));
		assert.deepEqual(namedOnly.inspect.messages[0], { role: "assistant", kind: "toolCall", text: "", name: "read" });
	});

	it("redacts credential-shaped text and sensitive path fields, and bounds the error message", () => {
		const projected = projectInspectReply(reply({
			task: "run with Bearer abc.def-token and apiKey=sk-live-1",
			messages: [{ role: "toolResult", kind: "toolResult", text: 'artifactPath: C:\\runs\\secret\\events.jsonl\npassword=hunter2' }],
			error: undefined,
		}));
		assert.equal(projected.ok, true);
		const serialized = JSON.stringify(projected.inspect);
		assert.equal(serialized.includes("abc.def-token"), false);
		assert.equal(serialized.includes("sk-live-1"), false);
		assert.equal(serialized.includes("hunter2"), false);
		assert.equal(serialized.includes("C:\\\\runs\\\\secret"), false);
		assert.match(projected.inspect.task, /Bearer \[redacted\]/);
		assert.match(projected.inspect.task, /apiKey=\[redacted\]/);
		assert.match(projected.inspect.messages[0].text, /artifactPath: \[path omitted\]/);
	});

	it("maps an extension error payload to a bounded code and message", () => {
		const projected = projectInspectReply(reply({
			error: { code: "foreign_session", message: `Inspection is only available for the current session (${"y".repeat(4000)})` },
		}));
		assert.equal(projected.ok, false);
		assert.equal(projected.reason, "extension_error");
		assert.equal(projected.error.code, "foreign_session");
		assert.equal(projected.error.message.length, INSPECT_LIMITS.maxErrorChars);
		assert.equal(projected.error.message.endsWith("…"), true);

		const strange = projectInspectReply(reply({ error: { code: "teapot!!", message: "rejected" } }));
		assert.equal(strange.error.code, "teapot__", "an unknown code is normalized, never forwarded raw");
		assert.equal(strange.error.message, "rejected");

		const pathful = projectInspectReply(reply({ error: { code: "internal", message: "could not read C:\\runs\\secret\\status.json" } }));
		assert.equal(pathful.ok, false);
		assert.equal(pathful.error.message.includes("C:\\runs"), false, "an error message never echoes a host path");
		assert.equal(projectInspectReply(reply({ error: { code: "internal" } })).error.message, "pi-subagents inspection failed");
	});
});
