import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startBridgeServer } from "../src/core/bridge-server.js";
import { RequestStore } from "../src/core/request-store.js";

const ASSETS_DIR = fileURLToPath(new URL("../src/browser/", import.meta.url));

async function withBridge(run) {
	const calls = [];
	const control = {
		snapshot: () => ({ generation: 5, reloading: false }),
		reload: async () => ({ ok: false, status: 409, code: "not-used", message: "not used" }),
		sessionSnapshot: () => ({
			subagents: {
				available: true,
				state: "ready-data",
				fleet: { entries: [], totalActive: 0, omitted: 0 },
				asyncSnapshot: { runs: [{ id: "real-async-id", state: "running" }], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
			},
		}),
		sessionSubagentsDetails: async (generation, body) => {
			calls.push(["details", generation, body]);
			return { ok: true, id: body.id, text: "bounded transcript", summary: { id: body.id, state: "running" } };
		},
		sessionSubagentsRefresh: async (generation, body) => {
			calls.push(["refresh", generation, body]);
			return {
				ok: true,
				generation,
				subagents: {
					available: true,
					state: "ready-empty",
					fleet: { entries: [], totalActive: 0, omitted: 0 },
					asyncSnapshot: { runs: [], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
				},
			};
		},
	};
	const bridge = await startBridgeServer({ store: new RequestStore(), assetsDir: ASSETS_DIR, control });
	try {
		return await run({ bridge, calls });
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

test("routes authenticated read-only details and explicit status refresh with exact bodies", async () => {
	await withBridge(async ({ bridge, calls }) => {
		const stateResponse = await fetch(`${bridge.origin}/api/state`, { headers: authHeaders(bridge) });
		const state = await stateResponse.json();
		assert.equal(state.subagents.asyncSnapshot.runs[0].id, "real-async-id");

		const detail = await post(bridge, "/api/subagents/details", { generation: 5, id: "real-async-id" });
		assert.equal(detail.status, 200);
		assert.deepEqual(await detail.json(), { ok: true, id: "real-async-id", text: "bounded transcript", summary: { id: "real-async-id", state: "running" } });
		assert.deepEqual(calls[0], ["details", 5, { generation: 5, id: "real-async-id" }]);

		const refresh = await post(bridge, "/api/subagents/refresh", { generation: 5 });
		assert.equal(refresh.status, 200);
		assert.equal((await refresh.json()).subagents.state, "ready-empty");
		assert.deepEqual(calls[1], ["refresh", 5, { generation: 5 }]);
	});
});

test("rejects cross-site, stale, extra-field and arbitrary subagent requests before control", async () => {
	await withBridge(async ({ bridge, calls }) => {
		const badOrigin = await post(bridge, "/api/subagents/details", { generation: 5, id: "real-async-id" }, { Origin: "https://evil.example" });
		assert.equal(badOrigin.status, 403);
		assert.equal((await badOrigin.json()).error.code, "bad_origin");

		const stale = await post(bridge, "/api/subagents/details", { generation: 4, id: "real-async-id" });
		assert.equal(stale.status, 409);
		assert.equal((await stale.json()).error.code, "stale_generation");

		const extra = await post(bridge, "/api/subagents/refresh", { generation: 5, id: "not-accepted" });
		assert.equal(extra.status, 400);
		assert.equal((await extra.json()).error.code, "invalid_body");

		const missingAuth = await fetch(`${bridge.origin}/api/subagents/refresh`, {
			method: "POST",
			headers: { Origin: bridge.origin, "Content-Type": "application/json" },
			body: JSON.stringify({ generation: 5 }),
		});
		assert.equal(missingAuth.status, 401);
		assert.equal(calls.length, 0);
	});
});
