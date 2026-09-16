import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { startBridgeServer } from "../src/core/bridge-server.js";
import { RequestStore } from "../src/core/request-store.js";

const ASSETS_DIR = fileURLToPath(new URL("../src/browser/", import.meta.url));

async function withBridge(run, { sessionSnapshot = null } = {}) {
	let generation = 2;
	let reloading = false;
	const actions = [];
	const snapshotCalls = [];
	const bridge = await startBridgeServer({
		store: new RequestStore(),
		assetsDir: ASSETS_DIR,
		control: {
			snapshot: () => ({ generation, reloading }),
			reload: async () => ({ ok: false, status: 409, code: "not-used", message: "not used" }),
			sessionSnapshot: (options = {}) => {
				snapshotCalls.push(options);
				return sessionSnapshot ? sessionSnapshot(options) : { available: true, phase: "idle", revision: 1, messages: [] };
			},
			sessionMessage: async (expectedGeneration, body) => {
				if (expectedGeneration !== generation) {
					return { ok: false, status: 409, code: "stale_generation", message: "stale" };
				}
				actions.push({ expectedGeneration, action: "message", body });
				return { ok: true, accepted: true, delivery: "normal", phase: "starting" };
			},
			sessionStop: async (expectedGeneration, body) => {
				if (expectedGeneration !== generation) {
					return { ok: false, status: 409, code: "stale_generation", message: "stale" };
				}
				actions.push({ expectedGeneration, action: "stop", body });
				return { ok: true, requested: true, phase: "stopping" };
			},
		},
	});
	// Exclude the startup client self-check; the assertions below cover explicit browser state requests.
	snapshotCalls.length = 0;
	try {
		return await run({ bridge, actions, snapshotCalls });
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

describe("chat HTTP boundary", () => {
	it("surfaces current chat state and sends an authenticated generation-bound multiline message", async () => {
		await withBridge(async ({ bridge, actions }) => {
			const state = await fetch(`${bridge.origin}/api/state`, { headers: authHeaders(bridge) });
			assert.equal(state.status, 200);
			assert.deepEqual((await state.json()).chat, { available: true, phase: "idle", revision: 1, messages: [] });

			const response = await post(bridge, "/api/message", { generation: 2, text: "first line\nsecond line" });
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { ok: true, accepted: true, delivery: "normal", phase: "starting" });
			assert.deepEqual(actions[0], {
				expectedGeneration: 2,
				action: "message",
				body: { generation: 2, text: "first line\nsecond line" },
			});
		});
	});

	it("keeps the default state request on the complete-message path", async () => {
		await withBridge(async ({ bridge, snapshotCalls }) => {
			const response = await fetch(`${bridge.origin}/api/state`, { headers: authHeaders(bridge) });
			assert.equal(response.status, 200);
			assert.deepEqual((await response.json()).chat.messages, []);
			assert.deepEqual(snapshotCalls.at(-1), { chatSince: undefined });
		});
	});

	it("parses valid since values and treats invalid or too-large values as complete snapshots", async () => {
		const full = {
			available: true,
			phase: "idle",
			revision: 4,
			messagesFull: true,
			historyIds: ["entry:one", "entry:two"],
			messages: [{ id: "entry:one", revision: 1 }, { id: "entry:two", revision: 4 }],
		};
		const incremental = {
			...full,
			messagesFull: false,
			historyIds: ["entry:one", "entry:two"],
			messages: [{ id: "entry:two", revision: 4 }],
		};
		await withBridge(async ({ bridge, snapshotCalls }) => {
			for (const query of ["", "?since=bad", "?since=1234567890123", "?since=99"]) {
				const response = await fetch(`${bridge.origin}/api/state${query}`, { headers: authHeaders(bridge) });
				assert.equal(response.status, 200);
				assert.equal((await response.json()).chat.messagesFull, true);
			}
			const response = await fetch(`${bridge.origin}/api/state?since=2`, { headers: authHeaders(bridge) });
			assert.equal(response.status, 200);
			assert.deepEqual((await response.json()).chat.messages, incremental.messages);
			assert.equal(snapshotCalls.at(-1).chatSince, 2);
			assert.equal(snapshotCalls.slice(0, 3).every((options) => options.chatSince === undefined), true);
			assert.equal(snapshotCalls[3].chatSince, 99);
		}, {
			sessionSnapshot: (options) => options.chatSince === 2 ? incremental : full,
		});
	});

	it("returns the complete current id order so a removed message is pruned", async () => {
		const full = {
			available: true,
			phase: "idle",
			revision: 5,
			messagesFull: true,
			historyIds: ["entry:one", "entry:two"],
			messages: [{ id: "entry:one", revision: 1 }, { id: "entry:two", revision: 5 }],
		};
		const removed = {
			...full,
			revision: 6,
			messagesFull: false,
			historyIds: ["entry:two"],
			messages: [],
		};
		await withBridge(async ({ bridge }) => {
			const response = await fetch(`${bridge.origin}/api/state?since=5`, { headers: authHeaders(bridge) });
			assert.equal(response.status, 200);
			const chat = (await response.json()).chat;
			assert.deepEqual(chat.messages, []);
			assert.deepEqual(chat.historyIds, ["entry:two"]);
		}, {
			sessionSnapshot: (options) => options.chatSince === 5 ? removed : full,
		});
	});

	it("accepts 65536-character ASCII and multi-byte UTF-8 chat messages", async () => {
		await withBridge(async ({ bridge, actions }) => {
			for (const text of ["a".repeat(65536), "界".repeat(65536)]) {
				const response = await post(bridge, "/api/message", { generation: 2, text });
				assert.equal(response.status, 200);
				assert.equal((await response.json()).accepted, true);
				assert.equal(actions.at(-1).body.text.length, 65536);
			}
		});
	});

	it("rejects stale generations, missing generations, and cross-site control without invoking the session", async () => {
		await withBridge(async ({ bridge, actions }) => {
			const before = actions.length;
			const stale = await post(bridge, "/api/message", { generation: 1, text: "old" });
			assert.equal(stale.status, 409);
			assert.equal((await stale.json()).error.code, "stale_generation");
			const missing = await post(bridge, "/api/stop", {});
			assert.equal(missing.status, 400);
			assert.equal((await missing.json()).error.code, "invalid_generation");
			const crossSite = await post(bridge, "/api/message", { generation: 2, text: "blocked" }, { Origin: "https://evil.example" });
			assert.equal(crossSite.status, 403);
			assert.equal(actions.length, before);
		});
	});

	it("routes stop to the explicitly current session action", async () => {
		await withBridge(async ({ bridge, actions }) => {
			const response = await post(bridge, "/api/stop", { generation: 2 });
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { ok: true, requested: true, phase: "stopping" });
			assert.equal(actions.at(-1).action, "stop");
		});
	});

	it("rejects extra message and stop fields before the HTTP action callback", async () => {
		await withBridge(async ({ bridge, actions }) => {
			const message = await post(bridge, "/api/message", { generation: 2, text: "blocked", extra: true });
			assert.equal(message.status, 400);
			assert.equal((await message.json()).error.code, "invalid_body");

			const stop = await post(bridge, "/api/stop", { generation: 2, extra: true });
			assert.equal(stop.status, 400);
			assert.equal((await stop.json()).error.code, "invalid_body");
			assert.equal(actions.length, 0, "HTTP validation must not invoke session actions for extra fields");
		});
	});
});
