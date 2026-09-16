/**
 * SDK-host model/thinking adapter (work group 3).
 *
 * The adapter is driven by a fake `AgentSession` (the same public members the installed SDK
 * exposes) so the candidate allowlist, the action round trips and the explicit failure paths
 * are deterministic and involve no model call.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THINKING_LEVELS } from "../src/core/model-catalog.js";
import { HostModelBridge } from "../src/host/models.js";
import { createFakeSdk, fixtureModel } from "./helpers/fake-sdk.js";

function bridgeFor(options = {}, overrides = {}) {
	const fake = createFakeSdk(options);
	const bridge = new HostModelBridge({
		session: fake.session,
		generation: 7,
		...overrides,
	});
	return { fake, bridge };
}

describe("SDK host model and thinking controls", () => {
	it("snapshots the current model, levels and candidate keys without provider configuration", () => {
		const first = fixtureModel("openai", "gpt-one", "One");
		const duplicate = fixtureModel("openai", "gpt-one", "Duplicate");
		const second = fixtureModel("anthropic", "claude", "Claude", { reasoning: false });
		const { bridge } = bridgeFor({
			model: first,
			thinkingLevel: "high",
			availableThinkingLevels: ["off", "low", "high"],
			scopedModels: [
				{ model: first, thinkingLevel: "high" },
				{ model: duplicate, thinkingLevel: "low" },
				{ model: second },
			],
		});
		const snapshot = bridge.snapshot();

		assert.equal(snapshot.available, true);
		assert.equal(snapshot.thinkingLevel, "high");
		assert.deepEqual(snapshot.thinkingLevels, ["off", "low", "high"]);
		assert.deepEqual(snapshot.candidates.map((candidate) => candidate.key), ["openai/gpt-one", "anthropic/claude"]);
		assert.equal(snapshot.candidates[0].thinkingLevel, "high", "a scoped thinking pin stays visible");
		assert.equal(snapshot.candidates[1].thinkingLevel, undefined);
		assert.deepEqual(snapshot.candidates[1], {
			key: "anthropic/claude",
			provider: "anthropic",
			id: "claude",
			name: "Claude",
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 8192,
		});
		const serialized = JSON.stringify(snapshot);
		assert.equal(serialized.includes("should-not-leak"), false, "credentials and headers must never reach the browser");
		assert.equal(serialized.includes("private.invalid"), false, "provider base URLs must never reach the browser");
		assert.equal(serialized.includes("apiKey"), false);
	});

	it("falls back to the model runtime's available snapshot when the scope is empty", () => {
		const { bridge } = bridgeFor({ scopedModels: [], availableModels: [fixtureModel("google", "second", "Second")] });
		assert.deepEqual(bridge.snapshot().candidates.map((candidate) => candidate.key), ["google/second"]);
	});

	it("keeps an unavailable candidate source explicit instead of inventing candidates", () => {
		const { bridge } = bridgeFor({ availableModels: null });
		const snapshot = bridge.snapshot();
		assert.equal(snapshot.available, true, "the controls stay attached; only the candidate list is unknown");
		assert.deepEqual(snapshot.candidates, []);
		assert.equal(snapshot.lastError, "model candidates are temporarily unavailable");
	});

	it("refuses a candidate key that is not in the current allowlist before any host call", async () => {
		const { fake, bridge } = bridgeFor();
		const rejected = await bridge.selectModel(7, { generation: 7, key: "evil/provider" });
		assert.equal(rejected.ok, false);
		assert.equal(rejected.code, "model_not_allowed");
		assert.equal(rejected.status, 409);
		assert.deepEqual(rejected.current.candidates.map((candidate) => candidate.key), ["fixture/model-a", "fixture/model-b"]);
		assert.equal(fake.calls.modelChanges.length, 0, "a non-allowlisted key must never reach setModel()");

		const invalidType = await bridge.selectModel(7, { generation: 7, key: 5 });
		assert.equal(invalidType.code, "invalid_model_key");
		const oversized = await bridge.selectModel(7, { generation: 7, key: "a".repeat(2048) });
		assert.equal(oversized.code, "invalid_model_key");
		assert.equal(fake.calls.modelChanges.length, 0);
	});

	it("passes only the allowlisted host model to setModel() and echoes the effective values", async () => {
		const pinned = fixtureModel("anthropic", "selected", "Selected", { reasoning: true, contextWindow: 64000 });
		const { fake, bridge } = bridgeFor({
			model: DEFAULT_CURRENT(),
			availableModels: [DEFAULT_CURRENT(), pinned],
			scopedModels: [{ model: pinned, thinkingLevel: "low" }],
		});
		const result = await bridge.selectModel(7, { generation: 7, key: "anthropic/selected" });
		assert.equal(result.ok, true);
		assert.equal(result.requestedKey, "anthropic/selected");
		assert.deepEqual(fake.calls.modelChanges, [{ model: pinned, options: undefined }]);
		assert.equal(fake.calls.modelChanges[0].options, undefined, "no persist option may be sent to the session");
		assert.deepEqual(fake.calls.thinkingChanges, [{ level: "low", options: undefined }], "the scoped thinking pin is applied");
		assert.deepEqual(result.effectiveModel, {
			provider: "anthropic",
			id: "selected",
			name: "Selected",
			reasoning: true,
			contextWindow: 64000,
			maxTokens: 8192,
		});
		assert.equal(result.effectiveThinkingLevel, "low");
		assert.equal(result.controls.model.id, "selected");
		assert.equal(bridge.snapshot().model.id, "selected", "the snapshot reports the session's actual model");
	});

	it("reports an activation failure explicitly and keeps the previous model active", async () => {
		const current = DEFAULT_CURRENT();
		const { fake, bridge } = bridgeFor({
			model: current,
			availableModels: [current, fixtureModel("anthropic", "missing", "Missing")],
			modelChangeError: new Error("No API key for anthropic/missing"),
		});
		const result = await bridge.selectModel(7, { generation: 7, key: "anthropic/missing" });
		assert.equal(result.ok, false);
		assert.equal(result.status, 409);
		assert.equal(result.code, "model_change_failed");
		assert.match(result.message, /the current model remains active/);
		assert.equal(JSON.stringify(result).includes("No API key"), false, "the provider message stays on the host");
		assert.equal(result.current.model.id, "model-a");
		assert.equal(bridge.snapshot().model.id, "model-a");
		assert.equal(bridge.snapshot().lastError, result.message);
		assert.equal(fake.calls.modelChanges.length, 1);

		const logs = [];
		const logged = new HostModelBridge({ session: fake.session, generation: 7, logger: (message) => logs.push(message) });
		await logged.selectModel(7, { generation: 7, key: "anthropic/missing" });
		assert.equal(logs.some((entry) => entry.includes("No API key for anthropic/missing")), true, "the host log keeps the reason");
	});

	it("treats a false return from setModel() as an explicit unauthenticated failure", async () => {
		const current = DEFAULT_CURRENT();
		const { fake, bridge } = bridgeFor({ model: current, availableModels: [current, fixtureModel("anthropic", "missing", "Missing")] });
		fake.session.setModel = async () => false;
		const result = await bridge.selectModel(7, { generation: 7, key: "anthropic/missing" });
		assert.equal(result.ok, false);
		assert.equal(result.code, "model_unavailable");
		assert.equal(bridge.snapshot().model.id, "model-a");
	});

	it("reports a pinned thinking failure after a successful model switch", async () => {
		const pinned = fixtureModel("anthropic", "selected", "Selected");
		const { bridge } = bridgeFor({
			model: DEFAULT_CURRENT(),
			availableModels: [DEFAULT_CURRENT(), pinned],
			scopedModels: [{ model: pinned, thinkingLevel: "low" }],
			thinkingChangeError: new Error("thinking fixture failure"),
		});
		const result = await bridge.selectModel(7, { generation: 7, key: "anthropic/selected" });
		assert.equal(result.ok, false);
		assert.equal(result.code, "thinking_change_failed");
		assert.match(result.message, /pinned thinking level could not be applied/);
		assert.equal(bridge.snapshot().model.id, "selected", "the model switch itself is reported truthfully");
	});

	it("echoes the host-clamped thinking level and rejects levels outside Pi's set", async () => {
		const { fake, bridge } = bridgeFor({ thinkingLevel: "medium", thinkingClampTo: "low" });
		const invalid = await bridge.setThinkingLevel(7, { generation: 7, level: "turbo" });
		assert.equal(invalid.status, 400);
		assert.equal(invalid.code, "invalid_thinking_level");
		assert.equal(fake.calls.thinkingChanges.length, 0);

		const result = await bridge.setThinkingLevel(7, { generation: 7, level: "high" });
		assert.equal(result.ok, true);
		assert.equal(result.requestedLevel, "high");
		assert.equal(result.effectiveLevel, "low");
		assert.equal(result.clamped, true);
		assert.equal(result.controls.thinkingLevel, "low");
		assert.deepEqual(fake.calls.thinkingChanges, [{ level: "high", options: undefined }], "the requested level is applied session-only");
		assert.equal(bridge.snapshot().thinkingLevel, "low", "the snapshot reports the host's clamped value");
	});

	it("reports a thinking failure without changing the effective level", async () => {
		const { bridge } = bridgeFor({ thinkingLevel: "medium", thinkingChangeError: new Error("thinking fixture failure") });
		const result = await bridge.setThinkingLevel(7, { generation: 7, level: "high" });
		assert.equal(result.ok, false);
		assert.equal(result.code, "thinking_change_failed");
		assert.equal(result.current.thinkingLevel, "medium");
	});

	it("bounds the request body, refuses stale generations and keeps the disposal state", async () => {
		const { fake, bridge } = bridgeFor();
		assert.equal((await bridge.selectModel(7, { generation: 7, key: "fixture/model-a", extra: true })).code, "invalid_body");
		assert.equal((await bridge.setThinkingLevel(7, { generation: 7, level: "low", extra: true })).code, "invalid_body");
		assert.equal((await bridge.selectModel(7, [1])).code, "invalid_body");
		assert.equal((await bridge.selectModel(6, { generation: 6, key: "fixture/model-a" })).code, "stale_generation");
		assert.equal((await bridge.setThinkingLevel(7, { generation: 8, level: "low" })).code, "stale_generation");

		bridge.dispose();
		assert.equal(bridge.active, false);
		assert.equal(bridge.snapshot().available, false);
		assert.equal(JSON.stringify(bridge.snapshot()).includes("model-a"), false, "the disposed snapshot drops the old session values");
		assert.equal((await bridge.selectModel(7, { generation: 7, key: "fixture/model-a" })).code, "stale_generation");
		assert.equal((await bridge.setThinkingLevel(7, { generation: 7, level: "low" })).code, "stale_generation");
		assert.equal(fake.calls.modelChanges.length, 0);
	});

	it("keeps the full public level list when the session cannot report available levels", () => {
		const { fake, bridge } = bridgeFor();
		fake.session.getAvailableThinkingLevels = () => {
			throw new Error("levels unavailable");
		};
		assert.deepEqual(bridge.snapshot().thinkingLevels, [...THINKING_LEVELS]);
		fake.session.getAvailableThinkingLevels = () => ["low", "bogus", "low", 7];
		assert.deepEqual(bridge.snapshot().thinkingLevels, ["low"], "only Pi's public levels are exposed");
	});

	it("requires a session with the public model actions", () => {
		assert.throws(() => new HostModelBridge({ session: { setModel: () => {} }, generation: 1 }), /setThinkingLevel/);
		assert.throws(() => new HostModelBridge({ session: null, generation: 1 }), /AgentSession/);
		assert.throws(() => new HostModelBridge({ session: createFakeSdk().session, generation: 0 }), /positive integer/);
	});
});

function DEFAULT_CURRENT() {
	return fixtureModel("fixture", "model-a", "Fixture model A");
}
