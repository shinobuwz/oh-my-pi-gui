/**
 * Browser-driven UI context behaviour: dialog round trips through the request store,
 * Pi-compatible return types, non-approval exits, explicit `custom` failure with an
 * unanswerable browser notice, and the safe degradation of every other
 * `ExtensionUIContext` member.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RequestStore } from "../src/core/request-store.js";
import { INSPECT_PAYLOAD_PREFIX, INSPECT_WIDGET_KEY } from "../src/core/inspect-reply.js";
import {
	BROWSER_PLAIN_THEME,
	CUSTOM_UNSUPPORTED_MESSAGE,
	createBrowserUIContext,
	MAX_INSPECT_WIDGET_CHARS,
	MAX_WIDGET_CAPTURES,
	UI_DIALOG_MEMBERS,
	UI_HOST_MEMORY_MEMBERS,
	UI_UNAVAILABLE_MEMBERS,
	UI_UNSUPPORTED_MEMBERS,
} from "../src/host/ui-context.js";

/** The full `ExtensionUIContext` member list of Pi 0.85.1's `types.d.ts`. */
const UI_CONTRACT_MEMBERS = [
	"select",
	"confirm",
	"input",
	"notify",
	"onTerminalInput",
	"setStatus",
	"setWorkingMessage",
	"setWorkingVisible",
	"setWorkingIndicator",
	"setHiddenThinkingLabel",
	"setWidget",
	"setFooter",
	"setHeader",
	"setTitle",
	"custom",
	"pasteToEditor",
	"setEditorText",
	"getEditorText",
	"editor",
	"addAutocompleteProvider",
	"setEditorComponent",
	"getEditorComponent",
	"theme",
	"getAllThemes",
	"getTheme",
	"setTheme",
	"getToolsExpanded",
	"setToolsExpanded",
];

function createContext() {
	const store = new RequestStore();
	const logs = [];
	const uiContext = createBrowserUIContext({ store, logger: (message) => logs.push(message) });
	return { store, uiContext, logs };
}

function pendingOf(store, kind) {
	const request = store.snapshot().pending.find((candidate) => candidate.kind === kind);
	assert.ok(request, `expected a pending ${kind} request`);
	return request;
}

describe("browser UI context dialogs", () => {
	it("implements every ExtensionUIContext member", () => {
		const { uiContext } = createContext();
		for (const member of UI_CONTRACT_MEMBERS) {
			assert.equal(member in uiContext, true, `ctx.ui.${member} must be present`);
			if (member !== "theme") {
				assert.equal(typeof uiContext[member], "function", `ctx.ui.${member} must be callable`);
			}
		}
		assert.equal(typeof uiContext.theme.fg, "function");
	});

	it("round-trips confirm/select/input/editor through the store with Pi's return types", async () => {
		const { store, uiContext } = createContext();

		const confirmPromise = uiContext.confirm("Probe confirm", "Confirm from the browser?");
		const confirmRequest = pendingOf(store, "confirm");
		assert.equal(confirmRequest.title, "Probe confirm");
		assert.equal(confirmRequest.message, "Confirm from the browser?");
		assert.equal(store.answer(confirmRequest.id, { action: "answer", value: true }).ok, true);
		const confirmValue = await confirmPromise;
		assert.equal(confirmValue, true);
		assert.equal(typeof confirmValue, "boolean");

		const selectPromise = uiContext.select("Probe select", ["Red", "Blue"]);
		const selectRequest = pendingOf(store, "select");
		assert.deepEqual(selectRequest.options, ["Red", "Blue"]);
		assert.equal(store.answer(selectRequest.id, { action: "answer", value: "Blue" }).ok, true);
		assert.equal(await selectPromise, "Blue");

		const inputPromise = uiContext.input("Probe input", "type here");
		const inputRequest = pendingOf(store, "input");
		assert.equal(inputRequest.placeholder, "type here");
		assert.equal(store.answer(inputRequest.id, { action: "answer", value: "typed" }).ok, true);
		assert.equal(await inputPromise, "typed");

		const editorPromise = uiContext.editor("Probe editor", "prefilled line");
		const editorRequest = pendingOf(store, "editor");
		assert.equal(editorRequest.prefill, "prefilled line");
		assert.equal(store.answer(editorRequest.id, { action: "answer", value: "edited text" }).ok, true);
		assert.equal(await editorPromise, "edited text");
	});

	it("passes the dialog timeout and abort signal into the store", async () => {
		const { store, uiContext } = createContext();
		const before = Date.now();
		const promise = uiContext.confirm("Timed", "expires", { timeout: 5_000 });
		const request = pendingOf(store, "confirm");
		assert.equal(typeof request.deadlineAt, "number");
		assert.ok(request.deadlineAt >= before + 4_000, "the store must carry the host-provided deadline");
		store.answer(request.id, { action: "cancel" });
		assert.equal(await promise, false);

		const controller = new AbortController();
		controller.abort();
		assert.equal(await uiContext.select("Aborted", ["A"], { signal: controller.signal }), undefined);
		assert.equal(store.snapshot().pending.length, 0);
	});

	it("keeps non-approval semantics for cancel, timeout, duplicates and shutdown", async () => {
		const { store, uiContext } = createContext();

		const cancelConfirm = uiContext.confirm("Cancel me", "cancel");
		const cancelRequest = pendingOf(store, "confirm");
		assert.equal(store.answer(cancelRequest.id, { action: "cancel" }).status, "cancelled");
		assert.equal(await cancelConfirm, false);

		const timedInput = uiContext.input("Timeout me", "", { timeout: 10 });
		assert.equal(await timedInput, undefined);

		const duplicateSelect = uiContext.select("Answer twice", ["A", "B"]);
		const duplicateRequest = pendingOf(store, "select");
		assert.equal(store.answer(duplicateRequest.id, { action: "answer", value: "A" }).ok, true);
		const duplicate = store.answer(duplicateRequest.id, { action: "answer", value: "B" });
		assert.equal(duplicate.ok, false);
		assert.equal(duplicate.status, 409);
		assert.equal(duplicate.code, "already_resolved");
		assert.equal(await duplicateSelect, "A");

		const shutdownEditor = uiContext.editor("Shutdown", "");
		const cancelled = store.cancelAll("shutdown");
		assert.equal(cancelled.length, 1);
		assert.equal(cancelled[0].kind, "editor");
		assert.equal(typeof cancelled[0].id, "string");
		assert.equal(await shutdownEditor, undefined);
		assert.equal(store.pendingCount, 0);
	});

	it("fails custom explicitly, never calls its factory and publishes an unanswerable notice", async () => {
		const { store, uiContext, logs } = createContext();
		let factoryCalls = 0;
		const error = await uiContext.custom(() => {
			factoryCalls += 1;
			return { render: () => [] };
		}).catch((reason) => reason);
		assert.equal(factoryCalls, 0, "the terminal component factory must never be invoked");
		assert.equal(error instanceof Error, true);
		assert.match(error.message, /not supported/);
		assert.match(error.message, /failed without approval/);
		assert.equal(CUSTOM_UNSUPPORTED_MESSAGE.includes("no invented answer"), true);
		assert.match(logs.join("\n"), /unsupported ctx\.ui\.custom prompt reported in the browser as notice/);

		const notice = pendingOf(store, "custom");
		assert.equal(notice.unsupported, true);
		assert.match(notice.unsupportedReason, /not supported/);

		const rejected = store.answer(notice.id, { action: "answer", value: "invented" });
		assert.equal(rejected.ok, false);
		assert.equal(rejected.status, 409);
		assert.equal(rejected.code, "unsupported_request");
		assert.equal(store.answer(notice.id, { action: "dismiss" }).status, "dismissed");
	});

	it("rejects every UI call after deactivate without creating requests", async () => {
		const { store, uiContext } = createContext();
		uiContext.deactivate();
		assert.equal(uiContext.isActive(), false);
		await assert.rejects(uiContext.confirm("Late", "late"), /shutting down/);
		await assert.rejects(uiContext.select("Late", ["A"]), /shutting down/);
		await assert.rejects(uiContext.custom(() => ({})), /shutting down/);
		assert.equal(store.snapshot().pending.length, 0);
	});
});

describe("browser UI context degradation", () => {
	it("records notify/setStatus/widgets/editor drafts in host memory and logs them", () => {
		const { uiContext, logs } = createContext();
		uiContext.notify("hello from an extension", "warning");
		uiContext.setStatus("model", "deepseek-flash");
		uiContext.setStatus("model", "deepseek-flash");
		uiContext.setStatus("model", undefined);
		uiContext.setWidget("activity", ["line one", "line two"], { placement: "belowEditor" });
		uiContext.setWidget("factory", () => ({}));
		uiContext.setTitle("pi-gui");
		uiContext.pasteToEditor("pasted");
		uiContext.setEditorText("drafted");
		uiContext.setWorkingMessage("working");
		uiContext.setWorkingVisible(true);
		uiContext.setWorkingIndicator({ frames: ["."] });
		uiContext.setHiddenThinkingLabel("thinking");
		uiContext.setToolsExpanded(true);

		assert.deepEqual(uiContext.getNotices(), [{ message: "hello from an extension", type: "warning" }]);
		assert.equal(uiContext.getStatuses().has("model"), false, "setStatus(key, undefined) must clear the entry");
		assert.deepEqual(uiContext.getWidget("activity"), { lines: ["line one", "line two"], placement: "belowEditor" });
		assert.equal(uiContext.getWidget("factory"), null, "component factories are not stored");
		assert.equal(uiContext.getTerminalTitle(), "pi-gui");
		assert.equal(uiContext.getEditorDraft(), "drafted");
		assert.deepEqual(uiContext.getWorkingState(), { message: "working", visible: true, indicator: { frames: ["."] }, hiddenThinkingLabel: "thinking" });
		assert.equal(uiContext.getToolsExpanded(), true);

		const text = logs.join("\n");
		assert.match(text, /extension notice \[warning\]: hello from an extension/);
		assert.match(text, /extension status \[model\]: deepseek-flash/);
		assert.match(text, /extension status \[model\]: \(cleared\)/);
		assert.match(text, /ctx\.ui\.setWidget is not represented/);
		assert.match(text, /ctx\.ui\.setTitle is not represented/);
		assert.match(text, /ctx\.ui\.setWorkingVisible is not represented/);
	});

	it("keeps a safe no-op for TUI-only members and logs each one once", () => {
		const { uiContext, logs } = createContext();
		assert.equal(uiContext.getAllThemes().length, 0);
		assert.equal(uiContext.getTheme("dark"), undefined);
		assert.deepEqual(uiContext.setTheme("dark"), { success: false, error: "theme switching is not supported by the SDK browser host" });
		assert.equal(uiContext.getEditorComponent(), undefined);
		uiContext.setEditorComponent(() => ({}));
		uiContext.addAutocompleteProvider(() => {});
		uiContext.setFooter(undefined);
		uiContext.setFooter(() => ({}));
		uiContext.setHeader(() => ({}));
		const unsubscribe = uiContext.onTerminalInput(() => {
			throw new Error("terminal input handlers must never run in the browser host");
		});
		assert.equal(typeof unsubscribe, "function");
		unsubscribe();

		const text = logs.join("\n");
		for (const member of UI_UNAVAILABLE_MEMBERS) {
			if (member === "getEditorComponent") {
				// A read-only getter that returns "no custom editor" is a valid answer, not a swallow.
				assert.equal(uiContext.getEditorComponent(), undefined);
				continue;
			}
			assert.match(text, new RegExp(`ctx\\.ui\\.${member} is not represented`), `${member} must log an explicit degradation`);
		}
		assert.equal(text.match(/ctx\.ui\.setFooter is not represented/g).length, 1, "degradation must be logged once per member, not per call");
		assert.equal(uiContext.getEditorComponent(), undefined);
	});

	it("serves a plain-text theme so extensions that style output do not throw", () => {
		const { uiContext, logs } = createContext();
		const theme = uiContext.theme;
		assert.equal(theme, BROWSER_PLAIN_THEME);
		assert.equal(theme.fg("accent", "plain"), "plain");
		assert.equal(theme.bg("selectedBg", "plain"), "plain");
		assert.equal(theme.bold("plain"), "plain");
		assert.equal(theme.getFgAnsi("accent"), "");
		assert.equal(theme.getThinkingBorderColor("high")("plain"), "plain");
		assert.match(logs.join("\n"), /ctx\.ui\.theme is not represented/);
	});

	it("bounds host-memory collections", () => {
		const { uiContext } = createContext();
		for (let index = 0; index < 60; index += 1) {
			uiContext.notify(`notice ${index}`);
			uiContext.setStatus(`key-${index}`, "value");
		}
		assert.equal(uiContext.getNotices().length, 50);
		assert.equal(uiContext.getNotices().at(-1).message, "notice 59");
		assert.equal(uiContext.getStatuses().size, 50);
		assert.equal(uiContext.getStatuses().has("key-0"), false);
	});

	it("classifies every ExtensionUIContext member exactly once", () => {
		const { uiContext } = createContext();
		const declared = [...UI_DIALOG_MEMBERS, ...UI_UNSUPPORTED_MEMBERS, ...UI_HOST_MEMORY_MEMBERS, ...UI_UNAVAILABLE_MEMBERS];
		assert.deepEqual([...declared].sort(), [...UI_CONTRACT_MEMBERS].sort());
		assert.deepEqual(declared.slice(0, 4), ["confirm", "select", "input", "editor"]);
		assert.deepEqual(uiContext.support.unsupported, ["custom"]);
	});
});

describe("browser UI context widget capture", () => {
	it("keeps an emit-then-retract inspect payload readable after the pane is cleared", () => {
		const { uiContext } = createContext();
		const payload = `${INSPECT_PAYLOAD_PREFIX}${JSON.stringify({
			kind: "pi-subagents.inspect-reply",
			version: 1,
			requestId: "req-1",
			messages: [{ role: "assistant", kind: "text", text: "x".repeat(60_000) }],
		})}`;
		assert.equal(payload.length > 60_000, true, "the fixture must exceed the generic widget line bound");

		uiContext.setWidget(INSPECT_WIDGET_KEY, [payload]);
		assert.deepEqual(uiContext.getWidget(INSPECT_WIDGET_KEY).lines, [payload], "the payload is not cut for the dedicated key");
		uiContext.setWidget(INSPECT_WIDGET_KEY, undefined);
		assert.equal(uiContext.getWidget(INSPECT_WIDGET_KEY), null, "retraction clears the visible pane");
		const capture = uiContext.getWidgetCapture(INSPECT_WIDGET_KEY);
		assert.ok(capture, "the captured payload survives the retraction");
		assert.equal(capture.lines[0], payload, "the captured line is byte-identical to the emitted payload");
		assert.equal(JSON.parse(capture.lines[0].slice(INSPECT_PAYLOAD_PREFIX.length)).requestId, "req-1");
	});

	it("keeps the generic widget pane bounds unchanged while still capturing updates", () => {
		const { uiContext } = createContext();
		const longLine = "y".repeat(10_000);
		const manyLines = Array.from({ length: 150 }, (_value, index) => `line ${index}`);
		manyLines[0] = longLine;
		uiContext.setWidget("activity", manyLines, { placement: "belowEditor" });

		const pane = uiContext.getWidget("activity");
		assert.equal(pane.lines.length, 100, "the pane still keeps at most 100 lines");
		assert.equal(pane.lines[0].length, 4000, "generic widget lines keep their 4000-character bound");
		assert.equal(pane.placement, "belowEditor");
		const capture = uiContext.getWidgetCapture("activity");
		assert.equal(capture.lines.length, 100);
		assert.equal(capture.lines[0].length, 4000, "only the dedicated inspect key gets the larger bound");
	});

	it("publishes widget updates to listeners and lets them unsubscribe", () => {
		const { uiContext } = createContext();
		const seen = [];
		const unsubscribe = uiContext.onWidgetUpdate((update) => seen.push(update));
		uiContext.setWidget("activity", ["one"]);
		uiContext.setWidget("activity", ["two"]);
		uiContext.setWidget("activity", undefined);
		uiContext.setWidget("factory", () => ({}));
		assert.equal(seen.length, 2, "only line emissions are published, not retractions or factories");
		assert.deepEqual(seen.map((entry) => entry.key), ["activity", "activity"]);
		assert.deepEqual(seen.map((entry) => entry.lines), [["one"], ["two"]]);
		assert.equal(seen[0].sequence < seen[1].sequence, true, "emissions carry their order");

		unsubscribe();
		uiContext.setWidget("activity", ["three"]);
		assert.equal(seen.length, 2, "an unsubscribed listener receives nothing");
		assert.equal(uiContext.widgetListenerCount(), 0);
	});

	it("isolates a throwing listener and bounds the number of readable captures", () => {
		const { uiContext, logs } = createContext();
		let calls = 0;
		uiContext.onWidgetUpdate(() => {
			calls += 1;
			throw new Error("listener exploded");
		});
		uiContext.onWidgetUpdate(() => {
			calls += 1;
		});
		uiContext.setWidget("activity", ["line"]);
		assert.equal(calls, 2, "every listener is called even when a previous one threw");
		assert.match(logs.join("\n"), /a widget update listener threw: listener exploded/);

		for (let index = 0; index < MAX_WIDGET_CAPTURES + 4; index += 1) {
			uiContext.setWidget(`key-${index}`, [`value ${index}`]);
		}
		assert.equal(uiContext.getWidgetCapture("key-0"), null, "the oldest capture is evicted");
		assert.equal(uiContext.getWidgetCapture(`key-${MAX_WIDGET_CAPTURES + 3}`).lines[0], `value ${MAX_WIDGET_CAPTURES + 3}`);
		assert.equal(uiContext.getWidgetCapture("never-emitted"), null);
	});

	it("survives a total capture budget: the newest emission is always readable", () => {
		const { uiContext } = createContext();
		const big = "z".repeat(MAX_INSPECT_WIDGET_CHARS - 1);
		for (let index = 0; index < 6; index += 1) {
			uiContext.setWidget(INSPECT_WIDGET_KEY, [big]);
			uiContext.setWidget(`other-${index}`, ["small"]);
		}
		const latest = uiContext.getWidgetCapture(INSPECT_WIDGET_KEY);
		assert.ok(latest, "an emission larger than the remaining budget is never the one dropped");
		assert.equal(latest.lines[0], big);
	});
});
