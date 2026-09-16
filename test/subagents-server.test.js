import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startBridgeServer } from "../src/core/bridge-server.js";
import { RequestStore } from "../src/core/request-store.js";

const ASSETS_DIR = fileURLToPath(new URL("../src/browser/", import.meta.url));

async function withBridge(run, overrides = {}) {
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
		sessionSubagentsInspect: async (generation, body) => {
			calls.push(["inspect", generation, body]);
			if (body.id === "foreign-run") {
				return { ok: false, status: 403, code: "foreign_session", message: "Inspection is only available for async runs owned by the current session." };
			}
			return {
				ok: true,
				generation,
				inspect: {
					asyncId: body.id,
					childId: body.childId,
					status: "completed",
					label: "Review",
					task: "Review the bounded change",
					messages: [{ role: "assistant", kind: "toolCall", text: '{"path":"src/x.js"}', name: "read" }],
					finalOutput: "final answer",
					truncated: { task: false, messages: 0, finalOutput: false },
				},
			};
		},
	};
	const bridge = await startBridgeServer({ store: new RequestStore(), assetsDir: ASSETS_DIR, control: { ...control, ...overrides } });
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

test("routes the structured inspection with an exact body and a bounded response", async () => {
	await withBridge(async ({ bridge, calls }) => {
		const inspect = await post(bridge, "/api/subagents/inspect", { generation: 5, id: "real-async-id" });
		assert.equal(inspect.status, 200);
		const payload = await inspect.json();
		assert.equal(payload.ok, true);
		assert.equal(payload.generation, 5, "the response carries the generation it answered for");
		assert.equal(payload.inspect.asyncId, "real-async-id");
		assert.equal(payload.inspect.messages[0].kind, "toolCall");
		assert.equal(payload.inspect.task, "Review the bounded change");
		assert.deepEqual(payload.inspect.truncated, { task: false, messages: 0, finalOutput: false });
		assert.deepEqual(calls[0], ["inspect", 5, { generation: 5, id: "real-async-id" }]);
		const serialized = JSON.stringify(payload);
		assert.equal(/[A-Za-z]:\\|\/(?:Users|home|tmp|var|private)\//.test(serialized), false, "no host path may appear in the response");

		const withChild = await post(bridge, "/api/subagents/inspect", { generation: 5, id: "real-async-id", childId: "child-id", lines: 40 });
		assert.equal(withChild.status, 200);
		assert.deepEqual(calls[1], ["inspect", 5, { generation: 5, id: "real-async-id", childId: "child-id", lines: 40 }]);

		const foreign = await post(bridge, "/api/subagents/inspect", { generation: 5, id: "foreign-run" });
		assert.equal(foreign.status, 403, "an extension error code decides the status");
		assert.equal((await foreign.json()).error.code, "foreign_session");
	});
});

test("rejects every invalid inspection request before control runs", async () => {
	await withBridge(async ({ bridge, calls }) => {
		const rejections = [
			[{ generation: 5, id: "real-async-id", view: "transcript" }, 400, "invalid_body", "extra field"],
			[{ generation: 5 }, 400, "invalid_body", "missing id"],
			[{ generation: 5, id: "" }, 400, "invalid_body", "empty id"],
			[{ generation: 5, id: 42 }, 400, "invalid_body", "non-string id"],
			[{ generation: 5, id: "x".repeat(257) }, 400, "invalid_body", "oversized id"],
			[{ generation: 5, id: "real-async-id", childId: "" }, 400, "invalid_body", "empty child id"],
			[{ generation: 5, id: "real-async-id", childId: 7 }, 400, "invalid_body", "non-string child id"],
			[{ generation: 5, id: "real-async-id", lines: 0 }, 400, "invalid_body", "lines below range"],
			[{ generation: 5, id: "real-async-id", lines: 201 }, 400, "invalid_body", "lines above range"],
			[{ generation: 5, id: "real-async-id", lines: 1.5 }, 400, "invalid_body", "fractional lines"],
			[{ generation: 5, id: "real-async-id", lines: "10" }, 400, "invalid_body", "string lines"],
			[{ generation: 5, id: "real-async-id", lines: null }, 400, "invalid_body", "null lines"],
			[{ generation: 0, id: "real-async-id" }, 400, "invalid_generation", "missing generation"],
			[{ generation: 4, id: "real-async-id" }, 409, "stale_generation", "stale generation"],
		];
		for (const [body, status, code, name] of rejections) {
			const response = await post(bridge, "/api/subagents/inspect", body);
			assert.equal(response.status, status, `${name} must be refused with ${status}`);
			assert.equal((await response.json()).error.code, code, name);
		}

		const crossSite = await post(bridge, "/api/subagents/inspect", { generation: 5, id: "real-async-id" }, { Origin: "https://evil.example" });
		assert.equal(crossSite.status, 403);
		assert.equal((await crossSite.json()).error.code, "bad_origin");

		const noToken = await fetch(`${bridge.origin}/api/subagents/inspect`, {
			method: "POST",
			headers: { Origin: bridge.origin, "Content-Type": "application/json" },
			body: JSON.stringify({ generation: 5, id: "real-async-id" }),
		});
		assert.equal(noToken.status, 401);
		assert.equal((await noToken.json()).error.code, "unauthorized");

		const wrongMethod = await fetch(`${bridge.origin}/api/subagents/inspect`, { headers: authHeaders(bridge) });
		assert.equal(wrongMethod.status, 405);

		assert.equal(calls.length, 0, "no refused request may reach the session adapter");
	});
});

test("reports an unattached inspect route as not_attached", async () => {
	await withBridge(async ({ bridge }) => {
		const response = await post(bridge, "/api/subagents/inspect", { generation: 5, id: "real-async-id" });
		assert.equal(response.status, 503);
		assert.equal((await response.json()).error.code, "not_attached");
	}, { sessionSubagentsInspect: undefined });
});
