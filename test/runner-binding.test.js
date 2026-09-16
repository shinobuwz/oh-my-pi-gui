/**
 * Real host binding tests: the installed Pi extension loader and ExtensionRunner run
 * the adapter together with a separate consumer extension and a separate lifecycle
 * observer extension, and dialogs are answered over the real loopback HTTP bridge.
 *
 * The terminal UI cannot run headless, so the bound application UI context is a
 * "poisoned" stub whose dialog methods throw: any dialog that reached the terminal
 * path would fail the test instead of passing silently.
 *
 * Reload tests drive the sequence AgentSession.reload() performs (session_shutdown ->
 * invalidate -> reload extensions -> new runner -> session_start) and answer over the
 * same authenticated HTTP client, which is the closest available stand-in for a real
 * browser page; a live TUI + browser run is still required for final acceptance.
 */

import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { join } from "node:path";

import {
	REPO_ROOT,
	URL_FILE_ENV,
	bridgeClient,
	createFakeHostPackage,
	createHarness,
	createHostHarness,
	locateHostPackage,
	parseToolResult,
	readBridgeUrl,
	resetBridgeProcessState,
	splitUrl,
	toolDefinition,
	formatErrorWithCause,
	isNonRetryablePortError,
} from "./helpers/host.js";
import { installRunnerCapture, resetRunnerCapture } from "../src/adapter/runner-capture.js";

const URL_FILE = join(REPO_ROOT, ".browser-ui", `url-test-${process.pid}`);
process.env[URL_FILE_ENV] = URL_FILE;
process.env.PI_BROWSER_UI_RELOAD_IDLE_MS = "400";

let hostPackage;

before(() => {
	hostPackage = locateHostPackage();
	process.env.PI_BROWSER_UI_PACKAGE_ROOT = hostPackage.packageRoot;
});

afterEach(async () => {
	if (harness) {
		await harness.runner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
		harness = null;
	}
	if (host?.current) {
		await host.shutdown("quit").catch(() => {});
	}
	host = null;
	await resetBridgeProcessState();
});

let harness;
let host;

async function waitForBridgeState(bridge, predicate, { timeoutMs = 15000, description = "bridge state" } = {}) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	for (;;) {
		try {
			const snapshot = await bridge.state();
			if (predicate(snapshot)) {
				return snapshot;
			}
		} catch (error) {
			lastError = error;
			if (isNonRetryablePortError(error)) {
				throw new Error(`non-retryable bridge error while waiting for ${description}: ${formatErrorWithCause(error)}`, { cause: error });
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`timed out waiting for ${description}${lastError ? `: ${formatErrorWithCause(lastError)}` : ""}`,
				{ cause: lastError ?? undefined },
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function waitForBridgeReady({ timeoutMs = 15000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	for (;;) {
		const url = readBridgeUrl();
		if (url) {
			try {
				const parsed = splitUrl(url);
				if (parsed.port > 0 && parsed.token) {
					const bridge = bridgeClient(parsed);
					await bridge.state();
					return bridge;
				}
				lastError = new Error("the URL file did not contain a usable port and token");
			} catch (error) {
				lastError = error;
				if (isNonRetryablePortError(error)) {
					throw new Error(`non-retryable bridge error while waiting for a reachable bridge URL: ${formatErrorWithCause(error)}`, { cause: error });
				}
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`timed out waiting for a reachable bridge URL${lastError ? `: ${formatErrorWithCause(lastError)}` : ""}`,
				{ cause: lastError ?? undefined },
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function bootHarness() {
	await resetBridgeProcessState();
	harness = await createHarness({ packageRoot: hostPackage.packageRoot });
	await harness.runner.emit({ type: "session_start", reason: "startup" });
	await waitForBridgeReady();
	return harness;
}

async function bootHost(options = {}) {
	await resetBridgeProcessState();
	host = await createHostHarness({ packageRoot: hostPackage.packageRoot, ...options });
	await host.boot();
	await waitForBridgeReady();
	return host;
}

function client() {
	const url = readBridgeUrl();
	assert.ok(url, "the bridge must publish its URL through the URL file");
	return bridgeClient(splitUrl(url));
}

async function postChatMessage(bridge, generation, text) {
	return fetch(`${bridge.origin}/api/message`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${bridge.token}`,
			Origin: bridge.origin,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ generation, text }),
	});
}

async function observerEvents(runner) {
	const tool = toolDefinition(harness?.modules ?? host.current.modules, runner ?? harness?.runner ?? host.current.runner, "observer_events");
	return parseToolResult(await tool.execute("observer-read", {}, undefined, undefined)).events;
}

describe("host prompt lifecycle notifications (host-emitted)", () => {
	beforeEach(async () => {
		await bootHarness();
	});

	it("emits ui_prompt_start/end for a browser-answered dialog", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe_select");
		const execution = tool.execute("lifecycle-1", {}, undefined, undefined);
		const pending = await bridge.waitForPending("select");

		const duringPrompt = await observerEvents();
		assert.deepEqual(
			duringPrompt.map((event) => event.type),
			["start"],
			"the host must report the open prompt span while the browser is waiting",
		);
		assert.equal(duringPrompt[0].kind, "select");
		assert.equal(duringPrompt[0].reason, "ui_prompt");

		assert.equal((await bridge.answer(pending.id, "Alpha")).status, 200);
		await execution;

		const afterPrompt = await observerEvents();
		assert.deepEqual(
			afterPrompt.map((event) => event.type),
			["start", "end"],
			"the host must close the span exactly once after the answer",
		);
		assert.equal(afterPrompt[0].kind, "select");
		assert.equal(afterPrompt[1].kind, "select");
		assert.equal(afterPrompt[1].reason, "ui_prompt");
	});

	it("coalesces concurrent prompts into one waiting span", async () => {
		const bridge = client();
		const first = toolDefinition(harness.modules, harness.runner, "consumer_probe_select");
		const second = toolDefinition(harness.modules, harness.runner, "consumer_probe_select");
		const firstRun = first.execute("lifecycle-2a", {}, undefined, undefined);
		const secondRun = second.execute("lifecycle-2b", {}, undefined, undefined);

		const snapshot = await bridge.waitForSnapshot(2);
		assert.deepEqual(
			(await observerEvents()).map((event) => event.type),
			["start"],
			"two concurrent prompts must share a single outer span",
		);

		const [alpha, beta] = snapshot.pending;
		assert.equal((await bridge.answer(alpha.id, "Alpha")).status, 200);
		assert.deepEqual(
			(await observerEvents()).map((event) => event.type),
			["start"],
			"the span stays open while the second prompt is still waiting",
		);
		assert.equal((await bridge.answer(beta.id, "Beta")).status, 200);
		assert.equal(parseToolResult(await firstRun).value, "Alpha");
		assert.equal(parseToolResult(await secondRun).value, "Beta");

		const events = await observerEvents();
		assert.deepEqual(
			events.map((event) => event.type),
			["start", "end"],
			"the coalesced span must close exactly once after all prompts resolve",
		);
	});

	it("keeps a nested prompt inside the outer span", async () => {
		const bridge = client();
		const nest = toolDefinition(harness.modules, harness.runner, "observer_nest");
		await nest.execute("lifecycle-3-nest", {}, undefined, undefined);

		const consumer = toolDefinition(harness.modules, harness.runner, "consumer_probe_select");
		const execution = consumer.execute("lifecycle-3", {}, undefined, undefined);

		const outer = await bridge.waitForPending("select");
		assert.equal(outer.title, "Probe select only");
		const nested = await bridge.waitForPending("confirm");
		assert.equal(nested.title, "Nested observer prompt");
		assert.deepEqual(
			(await observerEvents()).map((event) => event.type),
			["start"],
			"a nested prompt must not open a second waiting span",
		);

		assert.equal((await bridge.answer(nested.id, true)).status, 200);
		assert.equal((await bridge.answer(outer.id, "Beta")).status, 200);
		const payload = parseToolResult(await execution);
		assert.equal(payload.value, "Beta");

		const events = await observerEvents();
		assert.deepEqual(events.map((event) => event.type), ["start", "nested-answer", "end"]);
		assert.equal(events[1].value, true, "the nested prompt must receive its own browser answer");
	});
});

describe("browser round trip", () => {
	beforeEach(async () => {
		await bootHarness();
	});

	it("starts the bridge from session_start and binds the shared ctx.ui through the host wrapper", () => {
		const announcements = harness.poisoned.notifications.map((entry) => entry.message);
		assert.equal(announcements.length >= 1, true, "session_start must announce the browser URL");
		assert.match(announcements[0], /Browser UI ready: http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}/);
		assert.equal(existsSync(URL_FILE), true);
		assert.deepEqual(harness.poisoned.dialogCalls, []);

		const bound = harness.runner.getUIContext();
		assert.equal(harness.runner.createContext().ui, bound, "ctx.ui must be the rebound context");
		const events = harness.runner.getUIContext();
		assert.notEqual(events, harness.poisoned.uiContext, "the app UI context must not be exposed directly");
		assert.match(String(events.confirm), /withUIPrompt\("confirm"/, "the consumer-facing dialog must be the host wrapper");
		assert.notEqual(events.confirm, harness.poisoned.uiContext.confirm, "the browser must not expose the terminal dialog");
	});

	it("answers confirm/select/input/editor from the browser and continues the consumer flow", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe");
		const execution = tool.execute("call-roundtrip", {}, undefined, undefined);
		const answers = { confirm: true, select: "Blue", input: "typed from the browser", editor: "edited\nin the browser" };
		for (const kind of ["confirm", "select", "input", "editor"]) {
			const pending = await bridge.waitForPending(kind);
			assert.equal(pending.title, `Probe ${kind}`);
			const replied = await bridge.answer(pending.id, answers[kind]);
			assert.equal(replied.status, 200, JSON.stringify(replied.payload));
		}
		const payload = parseToolResult(await execution);
		assert.deepEqual(
			payload.calls.slice(0, 4).map((call) => ({ kind: call.kind, value: call.value, valueType: call.valueType })),
			[
				{ kind: "confirm", value: true, valueType: "boolean" },
				{ kind: "select", value: "Blue", valueType: "string" },
				{ kind: "input", value: "typed from the browser", valueType: "string" },
				{ kind: "editor", value: "edited\nin the browser", valueType: "string" },
			],
		);
		assert.deepEqual(harness.poisoned.dialogCalls, [], "no dialog may reach the terminal implementation");
		assert.equal(
			(await bridge.state()).pending.filter((request) => !request.unsupported).length,
			0,
			"no answerable request may stay pending after the consumer flow finished",
		);
	});

	it("surfaces real runner send_user_message errors and isolates detached generations", async () => {
		await bootHost();
		const bridge = client();
		const runner = host.current.runner;
		assert.equal(typeof runner.emitError, "function", "the real runner must expose its error injection seam");

		const accepted = await postChatMessage(bridge, 1, "accepted before delivery failure");
		assert.equal(accepted.status, 200);
		runner.emitError({ extensionPath: "<runtime>", event: "send_user_message", error: "host rejected delivery" });
		let snapshot = await bridge.state();
		assert.equal(snapshot.chat.lastError, "message delivery failed after acceptance: host rejected delivery");

		const oversized = "x".repeat(5000);
		runner.emitError({ extensionPath: "<runtime>", event: "send_user_message", error: oversized });
		snapshot = await bridge.state();
		assert.equal(snapshot.chat.lastError.startsWith("message delivery failed after acceptance: "), true);
		assert.equal(snapshot.chat.lastError.length <= "message delivery failed after acceptance: ".length + 4096, true);

		const acceptedAgain = await postChatMessage(bridge, 1, "accepted clears the failure");
		assert.equal(acceptedAgain.status, 200);
		assert.equal((await bridge.state()).chat.lastError, null, "a later successful acceptance must clear the prior delivery error");

		const oldRunner = host.current.runner;
		await host.reload();
		assert.equal((await bridge.state()).generation, 2);
		const beforeLateError = await bridge.state();
		oldRunner.emitError({ extensionPath: "<runtime>", event: "send_user_message", error: "late error from detached generation" });
		const afterLateError = await bridge.state();
		assert.equal(afterLateError.chat.lastError, beforeLateError.chat.lastError, "a detached runner error must not write into the new generation");
		assert.equal(/late error from detached generation/.test(afterLateError.chat.lastError ?? ""), false);
	});
});

describe("reconnect, duplicates and non-approval exits", () => {
	beforeEach(async () => {
		await bootHarness();
	});

	it("replays a pending request id to a reconnecting browser client", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe_select");
		const execution = tool.execute("call-reconnect", {}, undefined, undefined);
		const first = await bridge.waitForPending("select");
		const second = await waitForBridgeState(
			bridge,
			(snapshot) => snapshot.pending.some((request) => request.id === first.id),
			{ description: "the pending request after reconnect" },
		);
		assert.equal(second.pending.find((request) => request.id === first.id)?.id, first.id);
		const replied = await bridge.answer(first.id, "Alpha");
		assert.equal(replied.status, 200);
		const payload = parseToolResult(await execution);
		assert.equal(payload.value, "Alpha");
	});

	it("rejects duplicate replies and keeps the first answer", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe_select");
		const execution = tool.execute("call-duplicate", {}, undefined, undefined);
		const pending = await bridge.waitForPending("select");
		assert.equal((await bridge.answer(pending.id, "Beta")).status, 200);
		const duplicate = await bridge.answer(pending.id, "Alpha");
		assert.equal(duplicate.status, 409);
		assert.equal(duplicate.payload.error.code, "already_resolved");
		assert.equal(parseToolResult(await execution).value, "Beta");
	});

	it("keeps concurrent prompts of the same kind separate", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe_select");
		const first = tool.execute("call-concurrent-1", {}, undefined, undefined);
		const second = tool.execute("call-concurrent-2", {}, undefined, undefined);
		const snapshot = await bridge.waitForSnapshot(2);
		const [firstRequest, secondRequest] = snapshot.pending;
		assert.notEqual(firstRequest.id, secondRequest.id);
		assert.equal((await bridge.answer(secondRequest.id, "Beta")).status, 200);
		assert.equal((await bridge.answer(firstRequest.id, "Alpha")).status, 200);
		assert.equal(parseToolResult(await second).value, "Beta");
		assert.equal(parseToolResult(await first).value, "Alpha");
	});

	it("rejects answers that do not match the pending request", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe_select");
		const execution = tool.execute("call-invalid", {}, undefined, undefined);
		const pending = await bridge.waitForPending("select");
		const wrongOption = await bridge.answer(pending.id, "Purple");
		assert.equal(wrongOption.status, 400);
		assert.equal(wrongOption.payload.error.code, "invalid_value");
		const wrongType = await bridge.answer(pending.id, 42);
		assert.equal(wrongType.status, 400);
		assert.equal((await bridge.answer(pending.id, "Alpha")).status, 200);
		assert.equal(parseToolResult(await execution).value, "Alpha");
	});

	it("ends a timed-out prompt with the non-approval value and rejects late answers", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe_timeout");
		const execution = tool.execute("call-timeout", {}, undefined, undefined);
		const pending = await bridge.waitForPending("confirm");
		const payload = parseToolResult(await execution);
		assert.equal(payload.value, false);
		assert.equal(payload.valueType, "boolean");
		const late = await bridge.answer(pending.id, true);
		assert.equal(late.status, 409);
		assert.equal(late.payload.error.code, "already_resolved");
	});

	it("ends an aborted prompt with the non-approval value and rejects late answers", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe_abort");
		const execution = tool.execute("call-abort", {}, undefined, undefined);
		const pending = await bridge.waitForPending("confirm");
		const payload = parseToolResult(await execution);
		assert.equal(payload.value, false);
		assert.equal(payload.aborted, true);
		assert.equal((await bridge.answer(pending.id, true)).status, 409);
	});

	it("ends an explicitly cancelled prompt without approval", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe_select");
		const execution = tool.execute("call-cancel", {}, undefined, undefined);
		const pending = await bridge.waitForPending("select");
		const cancelled = await bridge.answer(pending.id, undefined, "cancel");
		assert.equal(cancelled.status, 200);
		assert.equal(cancelled.payload.status, "cancelled");
		assert.equal(parseToolResult(await execution).valueType, "undefined");
	});
});

describe("unsupported custom component prompts", () => {
	beforeEach(async () => {
		await bootHarness();
	});

	it("reports the unsupported interaction in the browser and fails the caller without approval", async () => {
		const bridge = client();
		const tool = toolDefinition(harness.modules, harness.runner, "consumer_probe");
		const execution = tool.execute("call-custom", {}, undefined, undefined);
		for (const kind of ["confirm", "select", "input", "editor"]) {
			const pending = await bridge.waitForPending(kind);
			await bridge.answer(pending.id, kind === "confirm" ? true : kind === "select" ? "Red" : "value");
		}
		const payload = parseToolResult(await execution);
		assert.match(payload.customError, /not supported in the browser UI/);
		const notices = (await bridge.state()).pending.filter((request) => request.unsupported);
		assert.equal(notices.length >= 1, true);
		assert.match(notices[0].message, /failed without approval/);
		assert.deepEqual(harness.poisoned.dialogCalls, [], "custom must not reach the terminal component path");
		// The host reports one prompt span per dialog, including the unsupported custom call.
		const spans = await observerEvents();
		assert.deepEqual(
			spans.map((event) => event.type),
			["start", "end", "start", "end", "start", "end", "start", "end", "start", "end"],
		);
		assert.deepEqual(
			spans.filter((event) => event.type === "start").map((event) => event.kind),
			["confirm", "select", "input", "editor", "custom"],
		);
		assert.equal((await bridge.answer(notices[0].id, undefined, "dismiss")).status, 200);
	});
});

describe("browser-initiated reload", () => {
	it("reloads with a pending dialog, keeps the same URL/token and rejects old-generation answers", async () => {
		await bootHost();
		const bridge = client();
		const before = splitUrl(readBridgeUrl());
		const tool = toolDefinition(host.current.modules, host.current.runner, "consumer_probe_select");
		const execution = tool.execute("reload-pending", {}, undefined, undefined);
		const pending = await bridge.waitForPending("select");

		const reload = await bridge.reload();
		assert.equal(reload.status, 202, JSON.stringify(reload.payload));
		assert.equal(reload.payload.generation, 2, "the reload must bind a new generation");

		// The pending dialog ended with its non-approval result instead of hanging.
		assert.equal(parseToolResult(await execution).valueType, "undefined");

		// Same browser entry point and token, single listener.
		const after = splitUrl(readBridgeUrl());
		assert.deepEqual(after, before, "reload must not rotate the URL, port or token");
		const stateAfter = await bridge.state();
		assert.equal(stateAfter.generation, 2);
		assert.equal(stateAfter.reloading, false);

		// Old request ids are refused, new-generation prompts are answered normally.
		const stale = await bridge.answer(pending.id, "Alpha");
		assert.equal(stale.status, 409, "an answer from the previous generation must be refused");
		assert.match(stale.payload.error.code, /already_resolved|stale_generation/);

		const next = toolDefinition(host.current.modules, host.current.runner, "consumer_probe_select");
		const nextRun = next.execute("reload-next", {}, undefined, undefined);
		const nextPending = await bridge.waitForPending("select");
		assert.equal((await bridge.answer(nextPending.id, "Beta")).status, 200);
		assert.equal(parseToolResult(await nextRun).value, "Beta");

		// No terminal dialog was used in either generation.
		for (const record of host.generations) {
			assert.deepEqual(record.poisoned.dialogCalls, []);
		}
		// The new generation's observer sees the host-emitted span for its own prompt.
		assert.deepEqual(
			(await observerEvents(host.current.runner)).map((event) => event.type),
			["start", "end"],
		);

		// The adopted server keeps following the current instance: a second reload works.
		const secondReload = await bridge.reload();
		assert.equal(secondReload.status, 202, JSON.stringify(secondReload.payload));
		assert.equal(secondReload.payload.generation, 3);
		assert.deepEqual(splitUrl(readBridgeUrl()), before, "the browser entry point must stay stable across reloads");
		const third = toolDefinition(host.current.modules, host.current.runner, "consumer_probe_select");
		const thirdRun = third.execute("reload-third", {}, undefined, undefined);
		const thirdPending = await bridge.waitForPending("select");
		assert.equal((await bridge.answer(thirdPending.id, "Beta")).status, 200);
		assert.equal(parseToolResult(await thirdRun).value, "Beta");
	});

	it("refuses answers while a reload is in flight", async () => {
		let releaseIdle;
		const idleGate = new Promise((resolve) => {
			releaseIdle = resolve;
		});
		await bootHost({ waitForIdle: () => idleGate });
		const bridge = client();
		const tool = toolDefinition(host.current.modules, host.current.runner, "consumer_probe_select");
		const execution = tool.execute("reload-window", {}, undefined, undefined);
		const pending = await bridge.waitForPending("select");

		const reload = bridge.reload();
		const during = await waitForBridgeState(bridge, (snapshot) => snapshot.reloading, {
			description: "the reload window",
		});
		assert.equal(during.reloading, true, "the bridge must report the reload window");
		const blocked = await bridge.answer(pending.id, "Alpha");
		assert.equal(blocked.status, 409);
		assert.equal(blocked.payload.error.code, "reloading");

		releaseIdle();
		const result = await reload;
		assert.equal(result.status, 202);
		assert.equal(parseToolResult(await execution).valueType, "undefined", "the pending prompt ends without approval before reloading");
		assert.equal((await bridge.state()).reloading, false);
	});

	it("reports a bounded refusal when the session never becomes idle", async () => {
		await bootHost({ waitForIdle: () => new Promise(() => {}) });
		const bridge = client();
		const result = await bridge.reload();
		assert.equal(result.status, 409);
		assert.equal(result.payload.error.code, "busy");
		const state = await bridge.state();
		assert.equal(state.reloading, false, "a refused reload must not leave the bridge locked");
		assert.equal(state.generation, 1, "no new generation may be created by a refused reload");
	});

	it("times out a stalled host reload, releases the lock and reports that completion is uncertain", async () => {
		const previousTimeout = process.env.PI_BROWSER_UI_RELOAD_TIMEOUT_MS;
		process.env.PI_BROWSER_UI_RELOAD_TIMEOUT_MS = "50";
		try {
			await bootHost();
			const originalReload = host.reload.bind(host);
			let releaseReload;
			const reloadGate = new Promise((resolve) => {
				releaseReload = resolve;
			});
			let finishReload;
			const reloadFinished = new Promise((resolve) => {
				finishReload = resolve;
			});
			host.reload = async () => {
				await reloadGate;
				try {
					return await originalReload();
				} finally {
					finishReload();
				}
			};
			const bridge = client();
			const result = await bridge.reload();
			assert.equal(result.status, 504);
			assert.equal(result.payload.error.code, "reload_timeout");
			assert.match(result.payload.error.message, /background/i);
			assert.match(result.payload.error.message, /retry/i);
			assert.match(result.payload.error.message, /completion was not confirmed/i);
			const state = await bridge.state();
			assert.equal(state.reloading, false, "a timed-out reload must release the reload lock");
			assert.equal(state.generation, 1, "a stalled reload must not fabricate a new generation");
			releaseReload();
			await reloadFinished;
			assert.equal((await bridge.state()).generation, 2, "a host reload that completes later must still bind the next generation");
		} finally {
			if (previousTimeout === undefined) {
				delete process.env.PI_BROWSER_UI_RELOAD_TIMEOUT_MS;
			} else {
				process.env.PI_BROWSER_UI_RELOAD_TIMEOUT_MS = previousTimeout;
			}
		}
	});

	it("reports a refusal when the host does not create a new generation", async () => {
		await bootHost();
		host.reload = async () => {};
		const bridge = client();
		const result = await bridge.reload();
		assert.equal(result.status, 409);
		assert.equal(result.payload.error.code, "reload_refused");
		assert.equal((await bridge.state()).reloading, false);
	});

	it("distinguishes a failed replacement attach from a reload where nothing changed", async () => {
		await bootHost();
		const bridge = client();
		const fake = createFakeHostPackage({ version: "0.84.0" });
		const previousRoot = process.env.PI_BROWSER_UI_PACKAGE_ROOT;
		host.reload = async () => {
			const old = host.current;
			await host.modules.emitSessionShutdownEvent(old.runner, { type: "session_shutdown", reason: "reload" });
			old.runner.invalidate();
			process.env.PI_BROWSER_UI_PACKAGE_ROOT = fake.dir;
			try {
				return await host.boot({ reason: "reload" });
			} finally {
				process.env.PI_BROWSER_UI_PACKAGE_ROOT = previousRoot;
			}
		};
		try {
			const result = await bridge.reload();
			assert.equal(result.status, 503, JSON.stringify(result.payload));
			assert.equal(result.payload.error.code, "attach_failed");
			assert.match(result.payload.error.message, /old browser binding was detached/i);
			assert.match(result.payload.error.message, /new extension instance could not be attached/i);
			assert.match(result.payload.error.message, /0\.84\.0 is not supported/);
			assert.equal(/nothing was changed/i.test(result.payload.error.message), false);
		} finally {
			process.env.PI_BROWSER_UI_PACKAGE_ROOT = previousRoot;
			fake.cleanup();
		}
	});

	it("keeps the server alive and returns attach_failed after a post-bump bind failure", async () => {
		await bootHost({
			configureRunner: ({ generation, runner }) => {
				if (generation !== 2) {
					return;
				}
				runner.setUIContext = () => {
					throw new Error("post-bump bind failure");
				};
			},
		});
		const bridge = client();
		const before = splitUrl(readBridgeUrl());
		const result = await bridge.reload();
		assert.equal(result.status, 503, JSON.stringify(result.payload));
		assert.equal(result.payload.error.code, "attach_failed");
		assert.match(result.payload.error.message, /post-bump bind failure/);
		assert.equal(existsSync(URL_FILE), true, "the URL file must survive the failed replacement attach");
		assert.deepEqual(splitUrl(readBridgeUrl()), before, "the failed replacement must keep the browser entry point");

		const stateResponse = await fetch(`${before.origin}/api/state`, {
			headers: { Authorization: `Bearer ${before.token}` },
		});
		assert.equal(stateResponse.status, 200, "the shared server must remain connected after attach_failed");
		const state = await stateResponse.json();
		assert.equal(state.generation, 2, "the generation bump must remain observable after the failed bind");
		assert.equal(state.reloading, false, "the failed reload scope must be cleared after its 503 response");
	});

	it("also reloads from the terminal command with a real command context", async () => {
		await bootHost();
		const command = host.current.runner.getCommand("browser-ui");
		assert.ok(command, "the /browser-ui command must be registered");
		await command.handler("reload", host.current.runner.createCommandContext());
		assert.equal((await client().state()).generation, 2);
		assert.equal((await client().state()).reloading, false);
	});
});

describe("session lifecycle", () => {
	it("uses the host's own reload handling for new sessions and keeps the browser entry", async () => {
		await bootHost();
		const bridge = client();
		const before = splitUrl(readBridgeUrl());
		await host.shutdown("new");
		await host.boot({ reason: "new", previousSessionFile: "/tmp/previous-session.jsonl" });
		const after = splitUrl(readBridgeUrl());
		assert.deepEqual(after, before, "a session replacement must keep the same browser entry point");
		const state = await bridge.state();
		assert.equal(state.generation, 2);
		assert.equal(state.reloading, false);

		const tool = toolDefinition(host.current.modules, host.current.runner, "consumer_probe_select");
		const execution = tool.execute("after-new", {}, undefined, undefined);
		const pending = await bridge.waitForPending("select");
		assert.equal((await bridge.answer(pending.id, "Alpha")).status, 200);
		assert.equal(parseToolResult(await execution).value, "Alpha");
	});

	it("releases the server, token and stale binding on host quit", async () => {
		await bootHarness();
		const bridge = client();
		const { origin } = splitUrl(readBridgeUrl());
		const staleConfirm = harness.runner.getUIContext().confirm;

		await harness.runner.emit({ type: "session_shutdown", reason: "quit" });

		assert.equal(readBridgeUrl(), null, "the URL file must be removed on quit");
		await assert.rejects(() => fetch(`${origin}/api/state`), "the bridge port must be closed");
		await assert.rejects(() => bridge.state(), "the old token must not work after quit");
		assert.throws(() => staleConfirm("stale", "must not fall back to the terminal"), /stale|detached/i);
		assert.deepEqual(harness.poisoned.dialogCalls, []);
		harness = null;
		await resetBridgeProcessState();
	});

	it("keeps the token usable across a reload and reports binding state from the status command", async () => {
		await bootHost();
		const bridge = client();
		const before = splitUrl(readBridgeUrl());
		await host.reload();
		assert.equal((await bridge.state()).generation, 2, "the token from before the reload must still authenticate");

		const command = host.current.runner.getCommand("browser-ui");
		await command.handler("status", host.current.runner.createCommandContext());
		const status = host.current.poisoned.notifications.at(-1).message;
		assert.match(status, /Browser UI: running · generation 2/);
		assert.match(status, new RegExp(before.origin.replace(/[.:]/g, "\\$&")));
		assert.match(status, /Runner capture: [1-9]\d* bind\(s\) via injected/);

		// `url` must report the live URL without throwing (regression guard for the
		// command reading a stale URL variable).
		await command.handler("url", host.current.runner.createCommandContext());
		const urlReport = host.current.poisoned.notifications.at(-1).message;
		assert.match(urlReport, new RegExp(before.origin.replace(/[.:]/g, "\\$&")));
		assert.match(urlReport, /t=[0-9a-f]{64}/);
	});

	it("reports an installed capture without a live bind as refused in status", async () => {
		await bootHarness();
		resetRunnerCapture();
		class UnusedExtensionRunner {
			setUIContext() {}
		}
		const capture = await installRunnerCapture({ importer: async () => ({ ExtensionRunner: UnusedExtensionRunner }) });
		assert.equal(capture.ok, true);

		const command = harness.runner.getCommand("browser-ui");
		await command.handler("status", harness.runner.createCommandContext());
		const status = harness.poisoned.notifications.at(-1).message;
		assert.match(status, /capture installed but has not bound to a live runner/);
		assert.match(status, /GUI will refuse to enable/);
		assert.match(status, /patched source: injected/);
		assert.doesNotMatch(status, /Runner capture: 0 bind\(s\) via/);
	});

	it("reports capture failure details and attempted/used sources in status", async () => {
		await bootHarness();
		resetRunnerCapture();
		const captureFailure = await installRunnerCapture({
			env: { PI_BROWSER_UI_PACKAGE_ROOT: hostPackage.packageRoot },
			argv: ["node"],
			importer: async () => {
				throw new Error("injected capture diagnostic failure");
			},
		});
		assert.equal(captureFailure.ok, false);

		const command = harness.runner.getCommand("browser-ui");
		await command.handler("status", harness.runner.createCommandContext());
		const status = harness.poisoned.notifications.at(-1).message;
		assert.match(status, /Runner capture: failed:/);
		assert.match(status, /injected capture diagnostic failure/);
		assert.match(status, /attempted source: injected/);
		assert.match(status, /used source: none/);
		assert.match(status, /candidate URL: \(none\)/);
		assert.match(status, /attempts: 1 candidate attempt\(s\)/);
	});

	it("hands the host back its own dialogs on explicit stop", async () => {
		await bootHost();
		const bridge = client();
		const stopBefore = splitUrl(readBridgeUrl());
		const tool = toolDefinition(host.current.modules, host.current.runner, "consumer_probe_select");
		const execution = tool.execute("stop-pending", {}, undefined, undefined);
		await bridge.waitForPending("select");

		const command = host.current.runner.getCommand("browser-ui");
		await command.handler("stop", host.current.runner.createCommandContext());

		assert.equal(parseToolResult(await execution).valueType, "undefined", "stop must end pending prompts without approval");
		await assert.rejects(() => fetch(`${stopBefore.origin}/api/state`), "stop must close the bridge port");
		assert.deepEqual(host.current.poisoned.dialogCalls, [], "no dialog reached the terminal while the bridge ran");
		assert.throws(
			() => host.current.runner.getUIContext().confirm("after-stop", "host path again"),
			/terminal confirm dialog must not be reached/,
			"after an explicit stop the host ctx.ui must be the host's own context again",
		);
	});
});
