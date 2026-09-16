/**
 * Factory contract: Pi docs forbid long-lived resources (sockets, timers, watchers)
 * in extension factories, so loading the extension must not start the bridge or
 * touch `ctx.ui`. The server starts from `session_start` or `/browser-ui start`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import browserInteraction, { DEFAULT_URL_FILE, URL_FILE_ENV } from "../extensions/browser-interaction/index.js";

function fakePiApi() {
	const handlers = new Map();
	const commands = new Map();
	return {
		handlers,
		commands,
		api: {
			on(event, handler) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			registerCommand(name, options) {
				commands.set(name, options);
			},
		},
	};
}

describe("extension factory contract", () => {
	it("registers handlers and a command without starting any resource", async () => {
		const { api, handlers, commands } = fakePiApi();
		const before = process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap" || resource === "Timeout").length;
		await browserInteraction(api);
		const after = process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap" || resource === "Timeout").length;
		assert.equal(after, before, "the factory must not open sockets or timers");
		assert.deepEqual([...handlers.keys()].sort(), [
			"agent_end",
			"agent_settled",
			"agent_start",
			"message_end",
			"message_start",
			"message_update",
			"model_select",
			"session_compact",
			"session_shutdown",
			"session_start",
			"session_tree",
			"thinking_level_select",
			"tool_execution_end",
			"tool_execution_start",
			"tool_execution_update",
		]);
		assert.equal(commands.has("browser-ui"), true);
	});

	it("keeps loading even when the host package can not be imported here", async () => {
		// Direct import (outside the host loader) can not resolve the host package; the
		// capture failure is recorded and only refuses later, at attach time.
		const { api } = fakePiApi();
		await assert.doesNotReject(() => browserInteraction(api));
	});

	it("keeps the documented default URL file inside the repository", () => {
		assert.match(DEFAULT_URL_FILE.replace(/\\/g, "/"), /\/\.browser-ui\/url$/);
		assert.equal(typeof URL_FILE_ENV, "string");
	});

	it("ignores non-tui modes instead of starting a half-usable bridge", async () => {
		const { api, handlers } = fakePiApi();
		await browserInteraction(api);
		const notifications = [];
		const ctx = {
			mode: "print",
			ui: {
				notify: (message, type) => notifications.push({ message, type }),
				setStatus: () => {},
			},
		};
		for (const handler of handlers.get("session_start")) {
			await handler({ type: "session_start", reason: "startup" }, ctx);
		}
		assert.equal(notifications.length, 0);
	});
});
