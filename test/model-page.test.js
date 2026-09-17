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

/** The page applies a pick on the select's own `change` event (no confirmation button). */
function pick(environment, id, value) {
	const select = environment.document.getElementById(id);
	select.value = value;
	select.dispatch("change");
}

function controlPosts(environment) {
	return environment.fetchCalls
		.filter((call) => call.path === "/api/model" || call.path === "/api/thinking")
		.map((call) => JSON.parse(call.options.body));
}

describe("browser model and thinking controls", () => {
	it("applies a pick on change and reports effective model/thinking results without claiming turn completion", async () => {
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

		pick(environment, "model-select", "anthropic/next");
		await flushTasks();
		assert.match(environment.document.getElementById("model-status").textContent, /effective model is anthropic\/next/i);
		assert.match(environment.document.getElementById("model-status").textContent, /current turn state is unchanged/i);

		pick(environment, "thinking-select", "high");
		await flushTasks();
		assert.match(environment.document.getElementById("thinking-status").textContent, /effective level is low/i);
		assert.match(environment.document.getElementById("thinking-status").textContent, /clamped/i);
		assert.match(environment.document.getElementById("thinking-status").textContent, /current turn state is unchanged/i);
		assert.deepEqual(controlPosts(environment), [
			{ generation: 6, key: "anthropic/next" },
			{ generation: 6, level: "high" },
		]);
	});

	it("shows the pick as sending and locks the select until the host answers", async () => {
		const environment = await boot();
		const modelSelect = environment.document.getElementById("model-select");
		const accepted = { ...controls, model: { provider: "anthropic", id: "next", name: "Next" } };
		let release = () => {};
		const inFlight = new Promise((resolve) => {
			release = resolve;
		});
		const originalFetch = environment.fetch;
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/model") {
				await inFlight;
				environment.setSnapshot({ revision: 2, pending: [], generation: 6, reloading: false, controls: accepted });
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ok: true,
						effectiveModel: { provider: "anthropic", id: "next", name: "Next" },
						controls: accepted,
					}),
				};
			}
			return originalFetch(path, options);
		};
		globalThis.fetch = environment.fetch;

		pick(environment, "model-select", "anthropic/next");
		await flushTasks();
		assert.equal(modelSelect.disabled, true, "a select whose change request is in flight must not take another pick");
		assert.match(environment.document.getElementById("model-status").textContent, /applying model/i);
		assert.deepEqual(controlPosts(environment), [{ generation: 6, key: "anthropic/next" }]);

		release();
		await flushTasks();
		assert.equal(modelSelect.disabled, false, "the select is usable again once the host answers");
		assert.equal(modelSelect.value, "anthropic/next");
		assert.match(environment.document.getElementById("model-status").textContent, /effective model is anthropic\/next/i);
	});

	it("does not post a pick that already matches the host's current model or level", async () => {
		const environment = await boot();
		pick(environment, "model-select", "openai/current");
		pick(environment, "thinking-select", "medium");
		await flushTasks();
		assert.deepEqual(controlPosts(environment), [], "re-picking the value already in effect must not post a second request");
		assert.equal(environment.document.getElementById("model-status").textContent, "");
		assert.equal(environment.document.getElementById("thinking-status").textContent, "");
		assert.equal(environment.document.getElementById("model-select").disabled, false);
		assert.equal(environment.document.getElementById("thinking-select").disabled, false);
	});

	it("keeps an uncommitted model and thinking pick across a poll re-render", async () => {
		const environment = await boot();
		const modelSelect = environment.document.getElementById("model-select");
		const thinkingSelect = environment.document.getElementById("thinking-select");
		modelSelect.value = "anthropic/next";
		thinkingSelect.value = "high";

		// The next poll (about every 600 ms) rebuilds both selects from the same controls
		// block: the current model is still openai/current, but the pick a change request
		// is carrying must not be snapped back to it before the request lands.
		environment.setSnapshot({ revision: 2, pending: [], generation: 6, reloading: false, controls });
		await environment.runNextTimer();
		assert.equal(modelSelect.value, "anthropic/next", "an uncommitted model pick must survive the poll re-render");
		assert.equal(thinkingSelect.value, "high", "an uncommitted thinking pick must survive the poll re-render");

		// Only a value the host stopped offering falls back to the current one.
		const retracted = { ...controls, candidates: [controls.candidates[0]] };
		environment.setSnapshot({ revision: 3, pending: [], generation: 6, reloading: false, controls: retracted });
		await environment.runNextTimer();
		assert.equal(modelSelect.value, "openai/current");
	});

	it("re-aligns the kept pick with the model the host accepted", async () => {
		const environment = await boot();
		const modelSelect = environment.document.getElementById("model-select");
		const accepted = { ...controls, model: { provider: "anthropic", id: "next", name: "Next" } };
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/model") {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ok: true,
						effectiveModel: { provider: "anthropic", id: "next", name: "Next" },
						controls: accepted,
					}),
				};
			}
			return { ok: true, status: 200, json: async () => ({ revision: 2, pending: [], generation: 6, reloading: false, controls: accepted }) };
		};
		globalThis.fetch = environment.fetch;
		pick(environment, "model-select", "anthropic/next");
		await flushTasks();
		assert.equal(modelSelect.value, "anthropic/next");
		assert.equal(environment.document.getElementById("model-current").textContent, "Current model: anthropic/next · Next");
		assert.equal(
			environment.fetchCalls.find((call) => call.path === "/api/model").options.body.includes("persist"),
			false,
			"the browser must not ask the host to persist the model to the Pi global default",
		);
	});

	it("keeps the select usable and reports a rejected model request", async () => {
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
		const modelSelect = environment.document.getElementById("model-select");
		pick(environment, "model-select", "anthropic/next");
		await flushTasks();
		assert.match(environment.document.getElementById("model-status").textContent, /model change rejected \(model_not_allowed\)/i);
		assert.deepEqual(controlPosts(environment), [{ generation: 6, key: "anthropic/next" }]);
		assert.equal(modelSelect.disabled, false, "a rejected pick must not lock the select");
	});
});
