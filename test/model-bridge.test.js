import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ModelBridge, THINKING_LEVELS } from "../src/adapter/model-bridge.js";

function model(provider, id, name, extra = {}) {
	return {
		provider,
		id,
		name,
		reasoning: true,
		contextWindow: 128000,
		maxTokens: 4096,
		baseUrl: "https://private.invalid/v1",
		headers: { Authorization: "Bearer should-not-leak" },
		...extra,
	};
}

function fixture({ scopedModels = [], available = [], current = available[0] ?? scopedModels[0]?.model, thinking = "medium", clamp = null, reject = false } = {}) {
	let currentModel = current;
	let currentThinking = thinking;
	const ctx = {
		get model() {
			return currentModel;
		},
		get thinkingLevel() {
			return currentThinking;
		},
		scopedModels,
		modelRegistry: {
			getAvailable() {
				return available;
			},
		},
	};
	const pi = {
		async setModel(next) {
			if (reject) {
				return false;
			}
			currentModel = next;
			return true;
		},
		getThinkingLevel() {
			return currentThinking;
		},
		setThinkingLevel(level) {
			if (clamp && THINKING_LEVELS.indexOf(level) > THINKING_LEVELS.indexOf(clamp)) {
				currentThinking = clamp;
			} else {
				currentThinking = level;
			}
		},
	};
	return { ctx, pi, getCurrent: () => ({ model: currentModel, thinking: currentThinking }) };
}

describe("generation-scoped model and thinking controls", () => {
	it("uses scoped models, keeps optional thinking pins, deduplicates stable provider/id keys, and strips unsafe fields", () => {
		const first = model("openai", "gpt-one", "One", { apiKey: "secret" });
		const duplicate = model("openai", "gpt-one", "Duplicate");
		const second = model("anthropic", "claude", "Claude");
		const { ctx, pi } = fixture({
			scopedModels: [
				{ model: first, thinkingLevel: "high" },
				{ model: duplicate, thinkingLevel: "low" },
				{ model: second },
			],
			current: first,
		});
		const bridge = new ModelBridge({ pi, ctx, generation: 7 });
		const snapshot = bridge.snapshot();

		assert.deepEqual(snapshot.candidates.map((candidate) => candidate.key), ["openai/gpt-one", "anthropic/claude"]);
		assert.equal(snapshot.candidates[0].thinkingLevel, "high");
		assert.equal(snapshot.candidates[1].thinkingLevel, undefined);
		assert.deepEqual(snapshot.model, {
			provider: "openai",
			id: "gpt-one",
			name: "One",
			reasoning: true,
			contextWindow: 128000,
			maxTokens: 4096,
		});
		assert.equal(JSON.stringify(snapshot).includes("private.invalid"), false);
		assert.equal(JSON.stringify(snapshot).includes("should-not-leak"), false);
	});

	it("uses getAvailable when scope is empty and rejects an arbitrary candidate key", async () => {
		const available = [model("openai", "first", "First"), model("openai", "first", "Duplicate"), model("google", "second", "Second")];
		const fixtureState = fixture({ scopedModels: [], available, current: available[0] });
		const bridge = new ModelBridge({ pi: fixtureState.pi, ctx: fixtureState.ctx, generation: 3 });
		assert.deepEqual(bridge.snapshot().candidates.map((candidate) => candidate.key), ["openai/first", "google/second"]);

		const rejected = await bridge.selectModel(3, { generation: 3, key: "evil/provider" });
		assert.equal(rejected.ok, false);
		assert.equal(rejected.code, "model_not_allowed");
		assert.equal(fixtureState.getCurrent().model.id, "first");
	});

	it("reports setModel false as an explicit failure and keeps the current model", async () => {
		const current = model("openai", "current", "Current");
		const unavailable = model("anthropic", "missing", "Missing");
		const fixtureState = fixture({ available: [current, unavailable], current, reject: true });
		const bridge = new ModelBridge({ pi: fixtureState.pi, ctx: fixtureState.ctx, generation: 5 });
		const result = await bridge.selectModel(5, { generation: 5, key: "anthropic/missing" });
		assert.equal(result.ok, false);
		assert.equal(result.code, "model_unavailable");
		assert.deepEqual(result.current.model, { provider: "openai", id: "current", name: "Current", reasoning: true, contextWindow: 128000, maxTokens: 4096 });
		assert.equal(fixtureState.getCurrent().model.id, "current");
	});

	it("returns the actual model after success and refreshes on the effective-state event", async () => {
		const current = model("openai", "current", "Current");
		const selected = model("anthropic", "selected", "Selected");
		const fixtureState = fixture({
			scopedModels: [{ model: current }, { model: selected, thinkingLevel: "high" }],
			available: [current, selected],
			current,
		});
		const bridge = new ModelBridge({ pi: fixtureState.pi, ctx: fixtureState.ctx, generation: 9 });
		const result = await bridge.selectModel(9, { generation: 9, key: "anthropic/selected" });
		assert.equal(result.ok, true);
		assert.equal(fixtureState.getCurrent().thinking, "high");
		assert.deepEqual(result.effectiveModel, {
			provider: "anthropic",
			id: "selected",
			name: "Selected",
			reasoning: true,
			contextWindow: 128000,
			maxTokens: 4096,
		});
		bridge.handle({ type: "model_select", model: selected }, fixtureState.ctx);
		assert.equal(bridge.snapshot().model.id, "selected");
		assert.equal(bridge.snapshot().revision > 0, true);
	});

	it("limits thinking requests and reports the host-clamped effective level", async () => {
		const current = model("openai", "current", "Current");
		const fixtureState = fixture({ available: [current], current, clamp: "low" });
		const bridge = new ModelBridge({ pi: fixtureState.pi, ctx: fixtureState.ctx, generation: 11 });
		assert.equal((await bridge.selectModel(11, { generation: 11, key: "openai/current", extra: true })).code, "invalid_body");
		assert.equal((await bridge.setThinkingLevel(11, { generation: 11, level: "low", extra: true })).code, "invalid_body");
		const invalid = await bridge.setThinkingLevel(11, { generation: 11, level: "turbo" });
		assert.equal(invalid.ok, false);
		assert.equal(invalid.code, "invalid_thinking_level");
		const result = await bridge.setThinkingLevel(11, { generation: 11, level: "high" });
		assert.deepEqual({ effectiveLevel: result.effectiveLevel, clamped: result.clamped }, { effectiveLevel: "low", clamped: true });
		assert.equal(bridge.snapshot().thinkingLevel, "low");
		bridge.handle({ type: "thinking_level_select", level: "low" }, fixtureState.ctx);
		assert.equal(bridge.snapshot().thinkingLevel, "low");
	});

	it("rejects stale generations and disposed controls without retaining the old context", async () => {
		const current = model("openai", "current", "Current");
		const fixtureState = fixture({ available: [current], current });
		const bridge = new ModelBridge({ pi: fixtureState.pi, ctx: fixtureState.ctx, generation: 13 });
		assert.equal((await bridge.setThinkingLevel(12, { generation: 12, level: "low" })).code, "stale_generation");
		bridge.dispose();
		assert.equal((await bridge.selectModel(13, { generation: 13, key: "openai/current" })).code, "stale_generation");
		assert.equal(bridge.snapshot().available, false);
	});
});
