import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { startBridgeServer } from "../src/core/bridge-server.js";
import { RequestStore } from "../src/core/request-store.js";

const ASSETS_DIR = fileURLToPath(new URL("../src/browser/", import.meta.url));

async function withBridge(run) {
	let generation = 4;
	const bridge = await startBridgeServer({
		store: new RequestStore(),
		assetsDir: ASSETS_DIR,
		control: {
			snapshot: () => ({ generation, reloading: false }),
			reload: async () => ({ ok: false, status: 409, code: "not-used", message: "not used" }),
			sessionSnapshot: () => ({
				controls: {
					available: true,
					model: { provider: "openai", id: "current", name: "Current" },
					thinkingLevel: "medium",
					thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
					candidates: [{ key: "openai/current", provider: "openai", id: "current", name: "Current" }],
				},
			}),
			sessionModel: async (expectedGeneration, body) => {
				if (expectedGeneration !== generation) {
					return { ok: false, status: 409, code: "stale_generation", message: "stale" };
				}
				if (body.key !== "openai/current") {
					return { ok: false, status: 409, code: "model_not_allowed", message: "not in allowlist" };
				}
				return {
					ok: true,
					requestedKey: body.key,
					effectiveModel: { provider: "openai", id: "current", name: "Current" },
					effectiveThinkingLevel: "medium",
					controls: { available: true, model: { provider: "openai", id: "current" }, thinkingLevel: "medium", candidates: [] },
				};
			},
			sessionThinking: async (expectedGeneration, body) => {
				if (expectedGeneration !== generation) {
					return { ok: false, status: 409, code: "stale_generation", message: "stale" };
				}
				if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(body.level)) {
					return { ok: false, status: 400, code: "invalid_thinking_level", message: "not allowed" };
				}
				return { ok: true, requestedLevel: body.level, effectiveLevel: "low", clamped: body.level !== "low", controls: { available: true, thinkingLevel: "low", candidates: [] } };
			},
		},
	});
	try {
		return await run({ bridge });
	} finally {
		await bridge.close();
	}
}

function authHeaders(bridge, extra = {}) {
	return { Authorization: `Bearer ${bridge.token}`, ...extra };
}

async function post(bridge, path, body, extraHeaders = {}) {
	return fetch(`${bridge.origin}${path}`, {
		method: "POST",
		headers: authHeaders(bridge, { Origin: bridge.origin, "Content-Type": "application/json", ...extraHeaders }),
		body: JSON.stringify(body),
	});
}

describe("model and thinking HTTP boundary", () => {
	it("exposes controls in authenticated state and routes allowlisted generation-bound actions", async () => {
		await withBridge(async ({ bridge }) => {
			const state = await fetch(`${bridge.origin}/api/state`, { headers: authHeaders(bridge) });
			assert.equal(state.status, 200);
			const payload = await state.json();
			assert.equal(payload.controls.model.id, "current");
			assert.deepEqual(payload.controls.candidates.map((candidate) => candidate.key), ["openai/current"]);

			const modelResponse = await post(bridge, "/api/model", { generation: 4, key: "openai/current" });
			assert.equal(modelResponse.status, 200);
			assert.equal((await modelResponse.json()).effectiveModel.id, "current");
			const thinkingResponse = await post(bridge, "/api/thinking", { generation: 4, level: "high" });
			assert.equal(thinkingResponse.status, 200);
			assert.equal((await thinkingResponse.json()).effectiveLevel, "low");

			const extraModel = await post(bridge, "/api/model", { generation: 4, key: "openai/current", extra: true });
			assert.equal(extraModel.status, 400);
			assert.equal((await extraModel.json()).error.code, "invalid_body");
			const extraThinking = await post(bridge, "/api/thinking", { generation: 4, level: "high", extra: true });
			assert.equal(extraThinking.status, 400);
			assert.equal((await extraThinking.json()).error.code, "invalid_body");
		});
	});

	it("rejects arbitrary ids, stale generations, bad origin and missing authentication", async () => {
		await withBridge(async ({ bridge }) => {
			const arbitrary = await post(bridge, "/api/model", { generation: 4, key: "provider/secret-or-url" });
			assert.equal(arbitrary.status, 409);
			assert.equal((await arbitrary.json()).error.code, "model_not_allowed");

			const stale = await post(bridge, "/api/thinking", { generation: 3, level: "low" });
			assert.equal(stale.status, 409);
			assert.equal((await stale.json()).error.code, "stale_generation");

			const badOrigin = await post(bridge, "/api/model", { generation: 4, key: "openai/current" }, { Origin: "https://evil.example" });
			assert.equal(badOrigin.status, 403);
			assert.equal((await badOrigin.json()).error.code, "bad_origin");

			const missing = await fetch(`${bridge.origin}/api/thinking`, {
				method: "POST",
				headers: { Origin: bridge.origin, "Content-Type": "application/json" },
				body: JSON.stringify({ generation: 4, level: "low" }),
			});
			assert.equal(missing.status, 401);
		});
	});
});
