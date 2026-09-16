/**
 * Chat HTTP end-to-end against the real SDK host bridge.
 *
 * The host runs with a fake (capable but deterministic) `AgentSession`: `/api/message`
 * and `/api/stop` go through the real loopback server, token/Host/Origin checks, exact
 * body allow-list and generation checks, and the state route projects the adapter's
 * snapshot. No model call, no network and no installed Pi package is involved.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { startHost } from "../src/host/host.js";
import { createFakeSdk } from "./helpers/fake-sdk.js";

const stubFetch = async () => ({ status: 200 });

/**
 * Deterministic read-only Git double. Injecting it also keeps the real `git` child out of the
 * temporary session cwd, whose open handle would otherwise race `rmSync` on Windows.
 */
function gitStub(branch = "main") {
	return (file, args, options, callback) => {
		queueMicrotask(() => callback(null, `${branch}\n`, ""));
		return { kill: () => {} };
	};
}

function userEntry(id, text, timestamp) {
	return {
		type: "message",
		id,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	};
}

async function withChatHost(run, { entries = [] } = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-gui-chat-"));
	const fake = createFakeSdk({ entries });
	const host = await startHost({
		cwd: tmp,
		urlFile: join(tmp, "url"),
		env: {},
		sdk: fake.sdk,
		fetch: stubFetch,
		print: () => {},
		statusExecFile: gitStub(),
	});
	try {
		return await run(host, fake);
	} finally {
		await host.close("test");
		rmSync(tmp, { recursive: true, force: true });
	}
}

function authHeaders(host, extra = {}) {
	return { Authorization: `Bearer ${host.bridge.token}`, ...extra };
}

async function state(host, query = "") {
	const response = await fetch(`${host.origin}/api/state${query}`, { headers: authHeaders(host) });
	return { status: response.status, payload: await response.json() };
}

async function post(host, path, body, extraHeaders = {}) {
	const response = await fetch(`${host.origin}${path}`, {
		method: "POST",
		headers: authHeaders(host, { Origin: host.origin, "Content-Type": "application/json", ...extraHeaders }),
		body: JSON.stringify(body),
	});
	return { status: response.status, payload: await response.json().catch(() => ({})) };
}

describe("SDK host chat over HTTP", () => {
	it("drives idle normal, streaming steer/follow-up, incremental state and stop", async () => {
		const entries = [userEntry("user-history", "from history", 1)];
		await withChatHost(async (host, fake) => {
			const initial = await state(host);
			assert.equal(initial.status, 200);
			assert.equal(initial.payload.generation, 1);
			assert.equal(initial.payload.chat.available, true);
			assert.equal(initial.payload.chat.phase, "idle");
			assert.equal(initial.payload.chat.canSend, true);
			assert.deepEqual(initial.payload.chat.messages.map((message) => message.text), ["from history"]);
			assert.deepEqual(initial.payload.chat.historyIds, ["entry:user-history"]);

			const sent = await post(host, "/api/message", { generation: 1, text: "first line\nsecond line" });
			assert.equal(sent.status, 200);
			assert.deepEqual(sent.payload, {
				ok: true,
				accepted: true,
				queued: false,
				delivery: "normal",
				requestedDelivery: "normal",
				execution: "pending",
				phase: "starting",
			});
			assert.deepEqual(fake.calls.prompts, [{ text: "first line\nsecond line", options: { expandPromptTemplates: true } }]);

			// The session starts a run and streams an assistant row; the same events feed the
			// page snapshot through the real route.
			host.session.isIdle = false;
			host.session.isStreaming = true;
			host.session.emit({ type: "agent_start" });
			host.session.emit({
				type: "message_start",
				message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "working" }] },
			});
			const streaming = await state(host);
			assert.equal(streaming.payload.chat.phase, "streaming");
			assert.equal(streaming.payload.chat.canSend, false);
			assert.equal(streaming.payload.chat.canSteer, true);
			assert.deepEqual(streaming.payload.chat.messages.map((message) => message.text), ["from history", "working"]);
			const since = streaming.payload.chat.revision;

			const steer = await post(host, "/api/message", { generation: 1, text: "hurry", delivery: "steer" });
			assert.equal(steer.status, 200);
			assert.equal(steer.payload.queued, true);
			assert.equal(steer.payload.delivery, "steer");
			assert.equal(steer.payload.execution, "pending");
			assert.deepEqual(fake.calls.prompts.at(-1).options, { expandPromptTemplates: true, streamingBehavior: "steer" });

			const followUp = await post(host, "/api/message", { generation: 1, text: "then this", deliverAs: "followUp" });
			assert.equal(followUp.status, 200);
			assert.equal(followUp.payload.delivery, "followUp");
			assert.equal(followUp.payload.queued, true);
			assert.deepEqual(fake.calls.prompts.at(-1).options, { expandPromptTemplates: true, streamingBehavior: "followUp" });

			const busy = await post(host, "/api/message", { generation: 1, text: "normal while busy" });
			assert.equal(busy.status, 409);
			assert.equal(busy.payload.error.code, "busy");
			assert.equal(fake.calls.prompts.length, 3, "a rejected busy message must not reach prompt()");

			const delta = await state(host, `?since=${since}`);
			assert.equal(delta.payload.chat.messagesFull, false);
			assert.deepEqual(delta.payload.chat.messages, [], "unchanged rows are not resent");
			assert.deepEqual(delta.payload.chat.historyIds, ["entry:user-history", "live:1"]);

			const stopped = await post(host, "/api/stop", { generation: 1 });
			assert.equal(stopped.status, 200);
			assert.deepEqual(stopped.payload, { ok: true, requested: true, phase: "stopping" });
			assert.equal(fake.calls.aborts, 1);
		}, { entries });
	});

	it("rejects bad tokens, origins, extra fields, stale generations, slash commands and oversized text before the session", async () => {
		await withChatHost(async (host, fake) => {
			const noToken = await fetch(`${host.origin}/api/message`, {
				method: "POST",
				headers: { Origin: host.origin, "Content-Type": "application/json" },
				body: JSON.stringify({ generation: 1, text: "hi" }),
			});
			assert.equal(noToken.status, 401);
			const wrongToken = await fetch(`${host.origin}/api/state`, { headers: { Authorization: "Bearer 0".repeat(64) } });
			assert.equal(wrongToken.status, 401);

			const crossSite = await post(host, "/api/message", { generation: 1, text: "hi" }, { Origin: "https://evil.example" });
			assert.equal(crossSite.status, 403);
			assert.equal(crossSite.payload.error.code, "bad_origin");
			const crossSiteFetch = await post(host, "/api/message", { generation: 1, text: "hi" }, { "Sec-Fetch-Site": "cross-site" });
			assert.equal(crossSiteFetch.status, 403);
			assert.equal(crossSiteFetch.payload.error.code, "bad_fetch_site");

			const extraMessage = await post(host, "/api/message", { generation: 1, text: "hi", extra: true });
			assert.equal(extraMessage.status, 400);
			assert.equal(extraMessage.payload.error.code, "invalid_body");
			const extraStop = await post(host, "/api/stop", { generation: 1, extra: true });
			assert.equal(extraStop.status, 400);
			assert.equal(extraStop.payload.error.code, "invalid_body");

			const staleGeneration = await post(host, "/api/message", { generation: 9, text: "hi" });
			assert.equal(staleGeneration.status, 409);
			assert.equal(staleGeneration.payload.error.code, "stale_generation");
			const staleStop = await post(host, "/api/stop", { generation: 9 });
			assert.equal(staleStop.status, 409);

			const unknownDelivery = await post(host, "/api/message", { generation: 1, text: "hi", delivery: "sneak" });
			assert.equal(unknownDelivery.status, 409);
			assert.equal(unknownDelivery.payload.error.code, "unsupported_delivery");

			// Without a public command list, slash input is refused instead of being sent to
			// the model as plain text (fail-closed first version behaviour).
			const slashWithoutCatalog = await post(host, "/api/message", { generation: 1, text: "/review now" });
			assert.equal(slashWithoutCatalog.status, 503);
			assert.equal(slashWithoutCatalog.payload.error.code, "commands_unavailable");

			host.session.extensionRunner = { getRegisteredCommands: () => [{ invocationName: "review" }] };
			const catalogued = await post(host, "/api/message", { generation: 1, text: "/review now" });
			assert.equal(catalogued.status, 200);
			const unknownSlash = await post(host, "/api/message", { generation: 1, text: "/model gpt" });
			assert.equal(unknownSlash.status, 409);
			assert.equal(unknownSlash.payload.error.code, "unsupported_command");

			const oversized = await post(host, "/api/message", { generation: 1, text: "a".repeat(65537) });
			assert.equal(oversized.status, 413);
			assert.equal(oversized.payload.error.code, "message_too_long");

			assert.deepEqual(fake.calls.prompts.map((call) => call.text), ["/review now"], "only the catalogued slash command may reach prompt()");
			assert.equal(fake.calls.aborts, 0, "no rejected request may abort the session");
		});
	});

	it("surfaces an asynchronous prompt failure after acceptance through /api/state", async () => {
		await withChatHost(async (host) => {
			host.session.onPrompt = () => Promise.reject(new Error("no API key for provider-x"));
			const sent = await post(host, "/api/message", { generation: 1, text: "hello" });
			assert.equal(sent.status, 200);
			assert.equal(sent.payload.accepted, true, "acceptance must not claim the turn completed");
			await new Promise((resolve) => setImmediate(resolve));
			const after = await state(host);
			assert.match(after.payload.chat.lastError, /message delivery failed after acceptance: no API key for provider-x/);
		});
	});

	it("keeps the chat detached from session prompts after the host released the session", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-gui-chat-"));
		const fake = createFakeSdk();
		const host = await startHost({
			cwd: tmp,
			urlFile: join(tmp, "url"),
			env: {},
			sdk: fake.sdk,
			fetch: stubFetch,
			print: () => {},
			statusExecFile: gitStub(),
		});
		try {
			const closed = await host.close("test");
			assert.deepEqual(closed.errors, []);
			assert.equal(host.chat.active, false);
			assert.equal(fake.calls.unsubscriptions, 2, "the chat and status adapters release their subscriptions");
			// The released adapter must not accept actions for the next generation.
			const result = await host.chat.sendMessage(1, { generation: 1, text: "after close" });
			assert.equal(result.code, "stale_generation");
			assert.equal(fake.calls.prompts.length, 0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
