/**
 * Request store semantics: pending lifetime, explicit answers, non-approval exits,
 * duplicate/late reply rejection and input validation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LIMITS, RequestStore } from "../src/core/request-store.js";

describe("request store", () => {
	it("keeps a pending request addressable until the consumer contract ends it", async () => {
		const store = new RequestStore();
		const { id, promise } = store.create({ kind: "confirm", title: "T", message: "M" });
		assert.equal(store.pendingCount, 1);
		const snapshot = store.snapshot();
		assert.equal(snapshot.pending.length, 1);
		assert.equal(snapshot.pending[0].id, id);
		assert.equal(snapshot.pending[0].title, "T");
		store.answer(id, { action: "answer", value: true });
		assert.equal(await promise, true);
		assert.equal(store.pendingCount, 0);
	});

	it("resolves each dialog kind with the host contract type", async () => {
		const store = new RequestStore();
		const confirm = store.create({ kind: "confirm" });
		store.answer(confirm.id, { action: "answer", value: false });
		assert.equal(await confirm.promise, false);

		const select = store.create({ kind: "select", options: ["one", "two"] });
		store.answer(select.id, { action: "answer", value: "two" });
		assert.equal(await select.promise, "two");

		const input = store.create({ kind: "input" });
		store.answer(input.id, { action: "answer", value: "" });
		assert.equal(await input.promise, "");

		const editor = store.create({ kind: "editor" });
		store.answer(editor.id, { action: "answer", value: "multi\nline" });
		assert.equal(await editor.promise, "multi\nline");
	});

	it("rejects answers with the wrong shape, type or unknown values", async () => {
		const store = new RequestStore();
		const confirm = store.create({ kind: "confirm" });
		assert.deepEqual(store.answer(confirm.id, { action: "answer", value: "yes" }), {
			ok: false,
			status: 400,
			code: "invalid_value",
			message: "confirm answers must be a boolean",
		});
		const select = store.create({ kind: "select", options: ["a"] });
		assert.equal(store.answer(select.id, { action: "answer", value: "b" }).code, "invalid_value");
		const input = store.create({ kind: "input" });
		assert.equal(store.answer(input.id, { action: "answer", value: "x".repeat(LIMITS.inputChars + 1) }).code, "value_too_long");
		const editor = store.create({ kind: "editor" });
		assert.equal(store.answer(editor.id, { action: "answer", value: "x".repeat(LIMITS.editorChars + 1) }).code, "value_too_long");
		assert.equal(store.answer("nope", { action: "answer", value: true }).code, "unknown_request");
		assert.equal(store.answer(confirm.id, { action: "explode", value: true }).code, "invalid_action");
		// Invalid attempts must not settle the requests they targeted.
		assert.equal(store.pendingCount, 4);
		store.cancelAll("test");
		assert.equal(await confirm.promise, false);
		assert.equal(await select.promise, undefined);
		assert.equal(await input.promise, undefined);
		assert.equal(await editor.promise, undefined);
	});

	it("rejects duplicates and late replies after the request is gone", async () => {
		const store = new RequestStore();
		const { id, promise } = store.create({ kind: "confirm" });
		assert.equal(store.answer(id, { action: "answer", value: true }).ok, true);
		const duplicate = store.answer(id, { action: "answer", value: true });
		assert.equal(duplicate.ok, false);
		assert.equal(duplicate.status, 409);
		assert.equal(duplicate.code, "already_resolved");
		assert.equal(await promise, true);
	});

	it("ends with non-approval on explicit cancel, timeout and abort", async () => {
		const store = new RequestStore();
		const cancelled = store.create({ kind: "confirm" });
		store.answer(cancelled.id, { action: "cancel" });
		assert.equal(await cancelled.promise, false);
		assert.equal(store.answer(cancelled.id, { action: "answer", value: true }).code, "already_resolved");

		const timed = store.create({ kind: "confirm", timeoutMs: 20 });
		assert.equal(await timed.promise, false);
		assert.equal(store.answer(timed.id, { action: "answer", value: true }).code, "already_resolved");

		const controller = new AbortController();
		const aborted = store.create({ kind: "select", options: ["a"], signal: controller.signal });
		controller.abort();
		assert.equal(await aborted.promise, undefined);
		assert.equal(store.answer(aborted.id, { action: "answer", value: "a" }).code, "already_resolved");

		const preAborted = new AbortController();
		preAborted.abort();
		const immediate = store.create({ kind: "input", signal: preAborted.signal });
		assert.equal(await immediate.promise, undefined);
		assert.equal(store.pendingCount, 0);
	});

	it("exposes deadlines without changing the host contract", async () => {
		const store = new RequestStore();
		const { id, promise } = store.create({ kind: "input", timeoutMs: 1000 });
		const pending = store.snapshot().pending[0];
		assert.equal(pending.id, id);
		assert.ok(pending.deadlineAt > Date.now());
		store.cancelAll("test");
		assert.equal(await promise, undefined);
	});

	it("never lets the browser answer an unsupported interaction", async () => {
		const store = new RequestStore();
		const noticeId = store.createUnsupportedNotice({ title: "custom", message: "not supported" });
		const pending = store.snapshot().pending.find((request) => request.id === noticeId);
		assert.equal(pending.unsupported, true);
		const answer = store.answer(noticeId, { action: "answer", value: "anything" });
		assert.equal(answer.ok, false);
		assert.equal(answer.code, "unsupported_request");
		assert.equal(store.answer(noticeId, { action: "dismiss" }).status, "dismissed");
		assert.equal(store.pendingCount, 0);
	});

	it("bounds how many unsupported notices stay pending", () => {
		const store = new RequestStore();
		for (let index = 0; index < 8; index += 1) {
			store.createUnsupportedNotice({ title: `custom ${index}`, message: "not supported" });
		}
		assert.equal(store.pendingCount, 5);
		const statuses = store.resolvedHistory.map((entry) => entry.status);
		assert.equal(statuses.filter((status) => status === "superseded").length, 3);
	});

	it("ends every pending request with non-approval on shutdown", async () => {
		const store = new RequestStore();
		const confirm = store.create({ kind: "confirm" });
		const select = store.create({ kind: "select", options: ["a"] });
		const cancelled = store.cancelAll("session_shutdown:quit");
		assert.equal(cancelled.length, 2);
		assert.equal(await confirm.promise, false);
		assert.equal(await select.promise, undefined);
		assert.equal(store.pendingCount, 0);
		assert.equal(store.answer(confirm.id, { action: "answer", value: true }).code, "already_resolved");
	});

	it("rejects unknown request kinds at creation time", () => {
		const store = new RequestStore();
		assert.throws(() => store.create({ kind: "shell" }), /unsupported request kind/);
	});
});
