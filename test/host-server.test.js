/**
 * Host-to-browser wiring over real HTTP: the existing `/api/state` dialog section and
 * `/api/answer` are driven by the SDK host's request store (not by the previous
 * registry/adapter path), the page's unwired chat/model/status/subagent panels stay
 * non-crashing until their work groups land, and the loopback security checks are
 * unchanged.
 *
 * The HTTP client is `node:http` on purpose: the fake page environment replaces the
 * global `setTimeout`, which undici (Node's `fetch`) needs for its own sockets.
 */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { startHost } from "../src/host/host.js";
import { createFakeSdk } from "./helpers/fake-sdk.js";
import { createFakeEnvironment, importPage, installPageGlobals } from "./helpers/fake-dom.js";

const stubFetch = async () => ({ status: 200 });
let restoreGlobals = null;
let bust = 0;

/** Deterministic read-only Git double so the status panel never depends on the machine. */
function gitStub(branch = "main") {
	return (file, args, options, callback) => {
		queueMicrotask(() => callback(null, `${branch}\n`, ""));
		return { kill: () => {} };
	};
}

afterEach(() => {
	restoreGlobals?.();
	restoreGlobals = null;
});

async function withHost(run, options = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-gui-server-"));
	const { sdk } = createFakeSdk();
	const host = await startHost({
		cwd: tmp,
		urlFile: join(tmp, "url"),
		env: {},
		sdk,
		fetch: stubFetch,
		print: () => {},
		statusExecFile: options.git ?? gitStub(),
	});
	try {
		return await run(host, tmp);
	} finally {
		await host.close("test");
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Raw loopback HTTP client; the bridge never sees a browser proxy here. */
function request(host, path, { method = "GET", headers = {}, body } = {}) {
	return new Promise((resolvePromise, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port: host.port, path, method, headers }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let payload = {};
				try {
					payload = JSON.parse(text);
				} catch {
					payload = { raw: text };
				}
				resolvePromise({ status: res.statusCode, payload });
			});
		});
		req.on("error", reject);
		if (body !== undefined) {
			req.write(JSON.stringify(body));
		}
		req.end();
	});
}

function authHeaders(host, extra = {}) {
	return { Authorization: `Bearer ${host.bridge.token}`, ...extra };
}

function getState(host) {
	return request(host, "/api/state", { headers: authHeaders(host) });
}

function answer(host, body, extraHeaders = {}) {
	return request(host, "/api/answer", {
		method: "POST",
		headers: authHeaders(host, { Origin: host.origin, "Content-Type": "application/json", ...extraHeaders }),
		body,
	});
}

function reload(host) {
	return request(host, "/api/reload", {
		method: "POST",
		headers: authHeaders(host, { Origin: host.origin, "Content-Type": "application/json" }),
		body: {},
	});
}

function pendingOf(host, kind) {
	const request = host.store.snapshot().pending.find((candidate) => candidate.kind === kind);
	assert.ok(request, `expected a pending ${kind} request`);
	return request;
}

describe("SDK host bridge", () => {
	it("serves host-store dialogs at /api/state and resolves them at /api/answer", async () => {
		await withHost(async (host) => {
			const confirm = host.uiContext.confirm("Probe confirm", "Answer in the browser?");
			const first = await getState(host);
			assert.equal(first.status, 200);
			assert.equal(first.payload.ok, true);
			assert.equal(first.payload.generation, 1);
			assert.equal(first.payload.reloading, false);
			assert.equal(typeof first.payload.revision, "number");
			const pending = first.payload.pending;
			assert.equal(pending.length, 1);
			assert.equal(pending[0].kind, "confirm");
			assert.equal(pending[0].title, "Probe confirm");
			assert.equal(pending[0].message, "Answer in the browser?");
			assert.equal(pending[0].unsupported, false);
			const chat = first.payload.chat;
			assert.equal(chat.available, true, "the SDK host wires the browser chat");
			assert.equal(chat.phase, "idle");
			assert.equal(chat.canSend, true);
			assert.deepEqual(chat.messages, []);
			assert.deepEqual(chat.historyIds, []);
			const controls = first.payload.controls;
			assert.equal(controls.available, true, "the SDK host wires the model/thinking controls");
			assert.deepEqual(
				{ provider: controls.model.provider, id: controls.model.id },
				{ provider: "fixture", id: "model-a" },
			);
			assert.deepEqual(controls.candidates.map((candidate) => candidate.key), ["fixture/model-a", "fixture/model-b"]);
			assert.equal(controls.thinkingLevel, "medium");
			assert.equal(first.payload.status.available, true, "the SDK host wires the session status panel");
			assert.equal(first.payload.status.cwd, host.cwd);
			assert.equal(
				"subagents" in first.payload,
				false,
				"a host shape without the public extension-event-bus exports leaves the read-only panel unattached (the page shows Unavailable) instead of reporting invented data",
			);

			const response = await answer(host, { id: pending[0].id, action: "answer", value: true });
			assert.equal(response.status, 200);
			assert.deepEqual(response.payload, { ok: true, status: "answered", id: pending[0].id, kind: "confirm" });
			assert.equal(await confirm, true);

			const after = await getState(host);
			assert.deepEqual(after.payload.pending, []);
		});
	});

	it("rejects unauthenticated, cross-site and malformed answers without resolving the dialog", async () => {
		await withHost(async (host) => {
			const select = host.uiContext.select("Probe select", ["Alpha", "Beta"]);
			const pending = pendingOf(host, "select");

			const unauthenticated = await request(host, "/api/state");
			assert.equal(unauthenticated.status, 401);
			assert.equal(unauthenticated.payload.error.code, "unauthorized");

			const badHost = await request(host, "/api/state", { headers: { ...authHeaders(host), Host: "localhost" } });
			assert.equal(badHost.status, 403);

			const crossSite = await answer(host, { id: pending.id, action: "answer", value: "Alpha" }, { Origin: "https://evil.example" });
			assert.equal(crossSite.status, 403);

			const extraField = await answer(host, { id: pending.id, action: "answer", value: "Alpha", extra: true });
			assert.equal(extraField.status, 400);
			assert.equal(extraField.payload.error.code, "invalid_body");

			const wrongType = await answer(host, { id: pending.id, action: "answer", value: 5 });
			assert.equal(wrongType.status, 400);
			assert.equal(wrongType.payload.error.code, "invalid_value");

			assert.equal(host.store.isPending(pending.id), true, "no rejected request may resolve the dialog");
			assert.equal(host.pendingCount, 1);

			const cancelled = await answer(host, { id: pending.id, action: "cancel" });
			assert.equal(cancelled.status, 200);
			assert.equal(await select, undefined, "cancel must end with the non-approval value");
		});
	});

	it("refuses an in-place reload with an explicit unavailable error", async () => {
		await withHost(async (host) => {
			const response = await reload(host);
			assert.equal(response.status, 501);
			assert.equal(response.payload.error.code, "reload_unavailable");
			assert.match(response.payload.error.message, /restart the host process/);
		});
	});

	it("renders the host dialog and chat snapshots in the served page without the unwired panels crashing", async () => {
		await withHost(async (host) => {
			// Fetch both snapshots before the fake page globals replace `setTimeout`. The Git
			// double resolves asynchronously, so wait for the first refresh to land.
			await host.status.refresh();
			const emptySnapshot = (await getState(host)).payload;
			assert.equal(emptySnapshot.chat.available, true, "the chat panel is wired to the SDK session");
			assert.equal(emptySnapshot.controls.available, true, "the model panel is wired to the SDK session");
			assert.equal(emptySnapshot.status.available, true, "the status panel is wired to the SDK session");
			const editor = host.uiContext.editor("Editor title <b>not html</b>", "draft");
			const pendingSnapshot = (await getState(host)).payload;

			const environment = createFakeEnvironment({ token: host.bridge.token });
			environment.setSnapshot(emptySnapshot);
			restoreGlobals = installPageGlobals(environment);
			bust += 1;
			await importPage({ bust: `host-server-${bust}` });
			await environment.runNextTimer();

			const document = environment.document;
			assert.equal(document.getElementById("connection").textContent, "Connected · no pending prompts");
			assert.equal(document.getElementById("status-state").textContent, "Connected", "the status panel renders the host status section");
			assert.equal(document.getElementById("status-cwd").textContent, host.cwd);
			assert.equal(document.getElementById("status-branch").textContent, "main", "the read-only Git branch comes from the injected query");
			assert.equal(document.getElementById("chat-phase").textContent, "Idle");
			assert.equal(document.getElementById("chat-send").disabled, false);
			assert.equal(document.getElementById("chat-stop").disabled, true);
			assert.equal(document.getElementById("chat-history").children.length, 0);
			assert.equal(document.getElementById("chat-empty").classList.contains("hidden"), false);
			assert.equal(document.getElementById("controls-state").textContent, "Connected", "the controls panel renders the host controls section");
			assert.equal(document.getElementById("model-current").textContent, "Current model: fixture/model-a · Fixture model A");
			assert.deepEqual(
				document.getElementById("model-select").children.map((option) => option.value),
				["fixture/model-a", "fixture/model-b"],
			);
			assert.equal(document.getElementById("thinking-select").value, "medium");
			assert.equal(document.getElementById("subagents-state").textContent, "Unavailable");
			assert.equal(document.getElementById("requests").children.length, 0);
			assert.equal(document.getElementById("empty").classList.contains("hidden"), false, "the empty state must be visible while nothing is pending");

			environment.setSnapshot(pendingSnapshot);
			await environment.runNextTimer();
			const cards = document.getElementById("requests").children;
			assert.equal(cards.length, 1);
			const card = cards[0];
			assert.equal(card.dataset.kind, "editor");
			assert.equal(card.querySelector(".card-title").textContent, "Editor title <b>not html</b>", "host text must be rendered as text");
			assert.equal(document.getElementById("empty").classList.contains("hidden"), true);

			// A real session event must reach the chat rows: the streaming messages come from
			// the host adapter's session subscription, not from a prebuilt snapshot.
			host.session.isIdle = false;
			host.session.isStreaming = true;
			host.session.emit({
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "streaming from the host session" }], timestamp: 1 },
			});
			const streamingSnapshot = (await getState(host)).payload;
			assert.equal(streamingSnapshot.chat.phase, "streaming");
			assert.equal(streamingSnapshot.chat.canSend, false);
			assert.equal(streamingSnapshot.chat.canSteer, true);
			assert.deepEqual(streamingSnapshot.chat.messages.map((message) => message.text), ["streaming from the host session"]);
			environment.setSnapshot(streamingSnapshot);
			await environment.runNextTimer();
			assert.equal(document.getElementById("chat-phase").textContent, "Streaming");
			assert.equal(document.getElementById("chat-send").disabled, true, "normal delivery is refused while streaming");
			assert.equal(document.getElementById("chat-stop").disabled, false);
			const streamingRows = document.getElementById("chat-history").children;
			assert.equal(streamingRows.length, 1);
			assert.equal(streamingRows[0].querySelector(".chat-text").textContent, "streaming from the host session");

			// Before the host attaches a chat adapter (for example while a startup dialog is
			// still open) `/api/state` carries no chat section: the panel must show
			// Unavailable and the page must keep working.
			const detached = { ...streamingSnapshot };
			delete detached.chat;
			environment.setSnapshot(detached);
			await environment.runNextTimer();
			assert.equal(document.getElementById("chat-phase").textContent, "Unavailable");
			assert.equal(document.getElementById("chat-empty").textContent, "Chat is not attached to the current Pi session.");
			assert.equal(document.getElementById("chat-send").disabled, true);
			assert.equal(document.getElementById("chat-history").children.length, 0);
			assert.equal(document.getElementById("connection").dataset.state, "online", "the rest of the page must stay connected");

			// The page must still answer through the same host store. Restore the real globals
			// first so the raw HTTP client keeps its own event-loop primitives.
			restoreGlobals?.();
			restoreGlobals = null;
			const pending = pendingOf(host, "editor");
			const response = await answer(host, { id: pending.id, action: "answer", value: "typed in the page" });
			assert.equal(response.status, 200);
			assert.equal(await editor, "typed in the page");
		});
	});

	it("ends pending dialogs with non-approval and stops the listener on close", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-gui-server-"));
		const { sdk } = createFakeSdk();
		const host = await startHost({
			cwd: tmp,
			urlFile: join(tmp, "url"),
			env: {},
			sdk,
			fetch: stubFetch,
			print: () => {},
			statusExecFile: gitStub(),
		});
		try {
			const input = host.uiContext.input("Pending input", "placeholder");
			const closed = await host.close("test");
			assert.deepEqual(closed.errors, []);
			assert.equal(await input, undefined);
			assert.equal(host.bridge.server.listening, false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
