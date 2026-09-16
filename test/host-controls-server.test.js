/**
 * Model/thinking/status HTTP end-to-end against the real SDK host bridge.
 *
 * The host runs with a fake (capable but deterministic) `AgentSession` and an injected Git
 * `execFile`: `/api/model` and `/api/thinking` go through the real loopback server, token/Host/
 * Origin checks, the exact body allow-list, the generation checks and the candidate allowlist,
 * while `/api/state` projects the model/thinking and status sections. No model call, no network
 * and no installed Pi package is involved.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { startHost } from "../src/host/host.js";
import { createFakeSdk } from "./helpers/fake-sdk.js";

const stubFetch = async () => ({ status: 200 });

/** Deterministic read-only Git double. */
function gitStub(branch = "feature/e2e") {
	const calls = [];
	return {
		calls,
		execFile(file, args, options, callback) {
			calls.push({ file, args, options });
			queueMicrotask(() => callback(null, `${branch}\n`, ""));
			return { kill: () => {} };
		},
	};
}

function usageEntry() {
	return { type: "message", id: "assistant-1", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 } } };
}

async function withControlsHost(run, options = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-gui-controls-"));
	const git = options.git ?? gitStub();
	const fake = createFakeSdk({
		entries: [usageEntry()],
		contextUsage: { tokens: 1200, contextWindow: 64000, percent: 1.875 },
		thinkingClampTo: "low",
		...options.fake,
	});
	const host = await startHost({
		cwd: tmp,
		urlFile: join(tmp, "url"),
		env: {},
		sdk: fake.sdk,
		fetch: stubFetch,
		print: () => {},
		statusExecFile: git.execFile,
	});
	try {
		return await run(host, fake, git, tmp);
	} finally {
		await host.close("test");
		rmSync(tmp, { recursive: true, force: true });
	}
}

function authHeaders(host, extra = {}) {
	return { Authorization: `Bearer ${host.bridge.token}`, ...extra };
}

async function state(host) {
	const response = await fetch(`${host.origin}/api/state`, { headers: authHeaders(host) });
	const text = await response.text();
	return { status: response.status, text, payload: JSON.parse(text) };
}

async function post(host, path, body, extraHeaders = {}) {
	const response = await fetch(`${host.origin}${path}`, {
		method: "POST",
		headers: authHeaders(host, { Origin: host.origin, "Content-Type": "application/json", ...extraHeaders }),
		body: JSON.stringify(body),
	});
	return { status: response.status, payload: await response.json().catch(() => ({})) };
}

describe("SDK host model/thinking/status over HTTP", () => {
	it("projects the model/thinking controls and the session status into /api/state", async () => {
		await withControlsHost(async (host, fake) => {
			const first = await state(host);
			assert.equal(first.status, 200);
			const controls = first.payload.controls;
			assert.equal(controls.available, true);
			assert.deepEqual(
				{ provider: controls.model.provider, id: controls.model.id, name: controls.model.name },
				{ provider: "fixture", id: "model-a", name: "Fixture model A" },
			);
			assert.equal(controls.thinkingLevel, "medium");
			assert.equal(controls.thinkingLevels.length, 7);
			assert.deepEqual(controls.candidates.map((candidate) => candidate.key), ["fixture/model-a", "fixture/model-b"]);
			assert.equal(controls.lastError, null);
			assert.equal(typeof controls.revision, "number");
			assert.equal(first.text.includes("should-not-leak"), false, "no credential, header or API key may be serialized");
			assert.equal(first.text.includes("private.invalid"), false, "no provider base URL may be serialized");

			const status = first.payload.status;
			assert.equal(status.available, true);
			assert.equal(status.cwd, host.cwd, "the status cwd comes from the public session manager");
			assert.deepEqual(status.tokens, { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, total: 128 });
			assert.deepEqual(status.contextUsage, { tokens: 1200, contextWindow: 64000, percent: 1.875 });
			await host.status.refresh();
			assert.deepEqual(host.status.snapshot().git, { branch: "feature/e2e", reason: null });
			assert.equal(
				"subagents" in first.payload,
				false,
				"this injected host shape has no public extension-event-bus exports, so the read-only subagents section stays unattached instead of being fabricated",
			);
			assert.equal(fake.calls.modelChanges.length, 0, "reading the state never touches the session model");
		});
	});

	it("round-trips an allowlisted model key and reports the effective model without persisting", async () => {
		await withControlsHost(async (host, fake) => {
			const response = await post(host, "/api/model", { generation: 1, key: "fixture/model-b" });
			assert.equal(response.status, 200);
			assert.equal(response.payload.ok, true);
			assert.equal(response.payload.requestedKey, "fixture/model-b");
			assert.equal(response.payload.effectiveModel.id, "model-b");
			assert.equal(response.payload.controls.model.id, "model-b");
			assert.deepEqual(response.payload.controls.candidates.map((candidate) => candidate.key), ["fixture/model-a", "fixture/model-b"]);

			assert.equal(fake.calls.modelChanges.length, 1);
			assert.equal(fake.calls.modelChanges[0].model.id, "model-b", "the host model object is passed, never the browser key");
			assert.equal(fake.calls.modelChanges[0].options, undefined, "no persist option may be sent");
			assert.equal(fake.calls.thinkingChanges.length, 0, "a scope-less candidate pins no thinking level");

			const after = await state(host);
			assert.equal(after.payload.controls.model.id, "model-b");
		});
	});

	it("refuses a model key outside the allowlist before the session is asked", async () => {
		await withControlsHost(async (host, fake) => {
			const unknown = await post(host, "/api/model", { generation: 1, key: "fixture/not-in-list" });
			assert.equal(unknown.status, 409);
			assert.equal(unknown.payload.error.code, "model_not_allowed");
			// The route reports the error code/message only; the current allowlist stays visible
			// through /api/state.
			const after = await state(host);
			assert.deepEqual(after.payload.controls.candidates.map((candidate) => candidate.key), ["fixture/model-a", "fixture/model-b"]);
			assert.equal(after.payload.controls.model.id, "model-a");

			const wrongType = await post(host, "/api/model", { generation: 1, key: 7 });
			assert.equal(wrongType.status, 400);
			assert.equal(wrongType.payload.error.code, "invalid_model_key");
			assert.equal(fake.calls.modelChanges.length, 0);
		});
	});

	it("keeps the previous model when the session refuses the switch", async () => {
		await withControlsHost(async (host, fake) => {
			fake.session.setModel = async (model, options) => {
				fake.calls.modelChanges.push({ model, options });
				throw new Error("No API key for fixture/model-b");
			};
			const response = await post(host, "/api/model", { generation: 1, key: "fixture/model-b" });
			assert.equal(response.status, 409);
			assert.equal(response.payload.error.code, "model_change_failed");
			assert.match(response.payload.error.message, /the current model remains active/);
			assert.equal(JSON.stringify(response.payload).includes("No API key"), false, "the provider message stays on the host");
			assert.equal((await state(host)).payload.controls.model.id, "model-a");
			assert.equal(fake.calls.modelChanges.length, 1);
		});
	});

	it("echoes the host-clamped thinking level and rejects unlisted levels and extra fields", async () => {
		await withControlsHost(async (host, fake) => {
			const clamped = await post(host, "/api/thinking", { generation: 1, level: "high" });
			assert.equal(clamped.status, 200);
			assert.equal(clamped.payload.requestedLevel, "high");
			assert.equal(clamped.payload.effectiveLevel, "low");
			assert.equal(clamped.payload.clamped, true);
			assert.equal(clamped.payload.controls.thinkingLevel, "low");
			assert.deepEqual(fake.calls.thinkingChanges, [{ level: "high", options: undefined }]);

			const invalid = await post(host, "/api/thinking", { generation: 1, level: "turbo" });
			assert.equal(invalid.status, 400);
			assert.equal(invalid.payload.error.code, "invalid_thinking_level");
			const extra = await post(host, "/api/thinking", { generation: 1, level: "low", persist: true });
			assert.equal(extra.status, 400);
			assert.equal(extra.payload.error.code, "invalid_body");
			assert.equal(fake.calls.thinkingChanges.length, 1, "a rejected request must never reach the session");
		});
	});

	it("keeps the existing token/Origin/body/generation rejections for the control routes", async () => {
		await withControlsHost(async (host, fake) => {
			const noToken = await fetch(`${host.origin}/api/model`, {
				method: "POST",
				headers: { Origin: host.origin, "Content-Type": "application/json" },
				body: JSON.stringify({ generation: 1, key: "fixture/model-a" }),
			});
			assert.equal(noToken.status, 401);
			const wrongToken = await fetch(`${host.origin}/api/state`, { headers: { Authorization: "Bearer 0".repeat(64) } });
			assert.equal(wrongToken.status, 401);

			const crossOrigin = await post(host, "/api/model", { generation: 1, key: "fixture/model-a" }, { Origin: "https://evil.example" });
			assert.equal(crossOrigin.status, 403);
			assert.equal(crossOrigin.payload.error.code, "bad_origin");
			const crossSite = await post(host, "/api/thinking", { generation: 1, level: "low" }, { "Sec-Fetch-Site": "cross-site" });
			assert.equal(crossSite.status, 403);
			assert.equal(crossSite.payload.error.code, "bad_fetch_site");

			const extraModel = await post(host, "/api/model", { generation: 1, key: "fixture/model-a", persist: true });
			assert.equal(extraModel.status, 400);
			assert.equal(extraModel.payload.error.code, "invalid_body");
			const extraThinking = await post(host, "/api/thinking", { generation: 1, level: "low", extra: true });
			assert.equal(extraThinking.status, 400);
			assert.equal(extraThinking.payload.error.code, "invalid_body");

			const missingGeneration = await post(host, "/api/model", { key: "fixture/model-a" });
			assert.equal(missingGeneration.status, 400);
			assert.equal(missingGeneration.payload.error.code, "invalid_generation");
			const staleModel = await post(host, "/api/model", { generation: 9, key: "fixture/model-a" });
			assert.equal(staleModel.status, 409);
			assert.equal(staleModel.payload.error.code, "stale_generation");
			const staleThinking = await post(host, "/api/thinking", { generation: 9, level: "low" });
			assert.equal(staleThinking.status, 409);
			assert.equal(staleThinking.payload.error.code, "stale_generation");

			const wrongMethod = await fetch(`${host.origin}/api/model`, { method: "GET", headers: authHeaders(host) });
			assert.equal(wrongMethod.status, 405);

			assert.equal(fake.calls.modelChanges.length, 0, "no rejected request may reach the session");
			assert.equal(fake.calls.thinkingChanges.length, 0);
		});
	});

	it("detaches the controls and the status panel when the host releases the session", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-gui-controls-"));
		const git = gitStub();
		const fake = createFakeSdk();
		const host = await startHost({
			cwd: tmp,
			urlFile: join(tmp, "url"),
			env: {},
			sdk: fake.sdk,
			fetch: stubFetch,
			print: () => {},
			statusExecFile: git.execFile,
		});
		try {
			const closed = await host.close("test");
			assert.deepEqual(closed.errors, []);
			assert.equal(host.model.active, false);
			assert.equal(host.status.active, false);
			assert.equal(host.model.snapshot().available, false);
			assert.equal(host.status.snapshot().available, false);
			assert.equal(fake.calls.unsubscriptions, 2, "the chat and status subscriptions are released with the session");

			const afterClose = await host.lifecycle.sessionModel(1, { generation: 1, key: "fixture/model-a" });
			assert.equal(afterClose.status, 503);
			assert.equal(afterClose.code, "not_attached");
			const afterCloseThinking = await host.lifecycle.sessionThinking(1, { generation: 1, level: "low" });
			assert.equal(afterCloseThinking.code, "not_attached");
			assert.equal(host.lifecycle.sessionSnapshot(), null);
			assert.equal(fake.calls.modelChanges.length, 0, "a released host must not change the model");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("never exposes the model fixture fields that only the host owns", async () => {
		await withControlsHost(async (host) => {
			const response = await fetch(`${host.origin}/api/state`, { headers: authHeaders(host) });
			const text = await response.text();
			for (const forbidden of ["should-not-leak", "private.invalid", "apiKey", "Authorization"]) {
				assert.equal(text.includes(forbidden), false, `${forbidden} must never be serialized into /api/state`);
			}
			const candidate = JSON.parse(text).controls.candidates[0];
			assert.deepEqual(Object.keys(candidate).sort(), ["contextWindow", "id", "key", "maxTokens", "name", "provider", "reasoning"]);
		});
	});
});
