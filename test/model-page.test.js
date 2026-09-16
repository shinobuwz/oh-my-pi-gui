import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createFakeEnvironment, flushTasks, importPage, installPageGlobals } from "./helpers/fake-dom.js";

let restoreGlobals = null;
let bust = 0;

afterEach(() => {
	restoreGlobals?.();
	restoreGlobals = null;
});

const controls = {
	available: true,
	model: { provider: "openai", id: "current", name: "Current" },
	thinkingLevel: "medium",
	thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	candidates: [
		{ key: "openai/current", provider: "openai", id: "current", name: "Current" },
		{ key: "anthropic/next", provider: "anthropic", id: "next", name: "Next", thinkingLevel: "high" },
	],
};

async function boot() {
	bust += 1;
	const environment = createFakeEnvironment({ token: "c".repeat(64) });
	environment.setSnapshot({ revision: 1, pending: [], generation: 6, reloading: false, controls });
	restoreGlobals = installPageGlobals(environment);
	await importPage({ bust: `model-${bust}` });
	await environment.runNextTimer();
	return environment;
}

describe("browser model and thinking controls", () => {
	it("renders allowlisted candidates and reports effective model/thinking results without claiming turn completion", async () => {
		const environment = await boot();
		const modelSelect = environment.document.getElementById("model-select");
		assert.deepEqual(modelSelect.children.map((option) => option.value), ["openai/current", "anthropic/next"]);
		assert.equal(modelSelect.value, "openai/current");
		assert.deepEqual(
			environment.document.getElementById("thinking-select").children.map((option) => option.value),
			["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		);

		const originalFetch = environment.fetch;
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/model") {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ok: true,
						effectiveModel: { provider: "anthropic", id: "next", name: "Next" },
						controls: { ...controls, model: { provider: "anthropic", id: "next", name: "Next" } },
					}),
				};
			}
			if (path === "/api/thinking") {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ok: true,
						requestedLevel: "high",
						effectiveLevel: "low",
						clamped: true,
						controls: { ...controls, model: { provider: "anthropic", id: "next", name: "Next" }, thinkingLevel: "low" },
					}),
				};
			}
			return originalFetch(path, options);
		};
		globalThis.fetch = environment.fetch;

		modelSelect.value = "anthropic/next";
		environment.document.getElementById("model-form").submit();
		await flushTasks();
		assert.match(environment.document.getElementById("model-status").textContent, /effective model is anthropic\/next/i);
		assert.match(environment.document.getElementById("model-status").textContent, /current turn state is unchanged/i);

		const thinkingSelect = environment.document.getElementById("thinking-select");
		thinkingSelect.value = "high";
		environment.document.getElementById("thinking-form").submit();
		await flushTasks();
		assert.match(environment.document.getElementById("thinking-status").textContent, /effective level is low/i);
		assert.match(environment.document.getElementById("thinking-status").textContent, /clamped/i);
		assert.match(environment.document.getElementById("thinking-status").textContent, /current turn state is unchanged/i);
		assert.deepEqual(
			environment.fetchCalls.filter((call) => call.path === "/api/model" || call.path === "/api/thinking").map((call) => JSON.parse(call.options.body)),
			[
				{ generation: 6, key: "anthropic/next" },
				{ generation: 6, level: "high" },
			],
		);
	});

	it("keeps controls usable and reports a rejected model request", async () => {
		const environment = await boot();
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/model") {
				return {
					ok: false,
					status: 409,
					json: async () => ({ ok: false, error: { code: "model_not_allowed", message: "candidate is no longer available" } }),
				};
			}
			return { ok: true, status: 200, json: async () => ({ revision: 2, pending: [], generation: 6, reloading: false, controls }) };
		};
		globalThis.fetch = environment.fetch;
		environment.document.getElementById("model-select").value = "anthropic/next";
		environment.document.getElementById("model-form").submit();
		await flushTasks();
		assert.match(environment.document.getElementById("model-status").textContent, /model change rejected \(model_not_allowed\)/i);
		assert.equal(environment.document.getElementById("model-apply").disabled, false);
	});
});
