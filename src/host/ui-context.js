/**
 * Browser-driven `ExtensionUIContext` for the SDK GUI host.
 *
 * Pi's extension runner wraps whatever context `session.bindExtensions()` receives with
 * its own `withUIPrompt` lifecycle wrapper, so `ui_prompt_start` / `ui_prompt_end` stay
 * host-emitted and nothing is fabricated here. This module only implements the UI
 * capabilities themselves:
 *
 * - `confirm` / `select` / `input` / `editor` become pending requests in the shared
 *   request store (visible at `/api/state`, answerable at `/api/answer`). Their resolved
 *   values follow Pi's contract exactly: `confirm` -> boolean, the others -> string or
 *   `undefined`. Timeout, abort, cancel, disconnect, duplicate and late answers all end
 *   with the non-approval value and never re-run the original flow (the store owns those
 *   rules).
 * - `custom` (including questionnaire-style components) is explicitly unsupported: the
 *   caller fails immediately with a clear error, a browser-visible notice that has no
 *   answer path is created, the factory is never invoked and nothing is invented.
 * - `notify`, `setStatus` and the remaining TUI-only members are handled with the
 *   smallest safe behaviour: values that can be kept safely are kept in host memory and
 *   logged, everything else degrades to a safe no-op with an explicit one-time log. No
 *   member throws an uncaught exception and none is silently ignored.
 */

/** Same unsupported wording as the previous browser bridge, so the semantics do not change. */
export const CUSTOM_UNSUPPORTED_MESSAGE =
	"ctx.ui.custom (custom terminal component prompts) is not supported by the SDK browser host. " +
	"The interaction failed without approval: no terminal fallback and no invented answer.";

/** Explicit error for any UI call that arrives after the host began shutting down. */
export const INACTIVE_MESSAGE =
	"the SDK browser host is shutting down; this interaction was not sent anywhere and was not approved";

/** One-line support summary for `--help`, logs and status reporting. */
export const UI_SUPPORT_SUMMARY =
	"confirm/select/input/editor are answered in the browser; ctx.ui.custom fails explicitly with a browser-visible, unanswerable notice; " +
	"notify and setStatus are recorded in host memory and logged on the host terminal; " +
	"TUI-only members (widgets, footer/header, terminal input, editor components, theme switching, tool-expansion state) degrade to a safe no-op with an explicit one-time log.";

/** Members implemented as blocking browser dialogs. */
export const UI_DIALOG_MEMBERS = Object.freeze(["confirm", "select", "input", "editor"]);
/** Members that are explicitly unsupported rather than degraded. */
export const UI_UNSUPPORTED_MEMBERS = Object.freeze(["custom"]);
/** Members kept in host memory (and logged) because the first-version page has no pane for them. */
export const UI_HOST_MEMORY_MEMBERS = Object.freeze([
	"notify",
	"setStatus",
	"setWidget",
	"setWorkingMessage",
	"setWorkingVisible",
	"setWorkingIndicator",
	"setHiddenThinkingLabel",
	"setTitle",
	"pasteToEditor",
	"setEditorText",
	"getEditorText",
	"getToolsExpanded",
	"setToolsExpanded",
	"theme",
]);
/** Members with no browser representation at all; calls are safe no-ops with an explicit log. */
export const UI_UNAVAILABLE_MEMBERS = Object.freeze([
	"onTerminalInput",
	"setFooter",
	"setHeader",
	"addAutocompleteProvider",
	"setEditorComponent",
	"getEditorComponent",
	"getAllThemes",
	"getTheme",
	"setTheme",
]);

const MAX_NOTICES = 50;
const MAX_STATUS_KEYS = 50;
const MAX_WIDGETS = 20;
const MAX_WIDGET_LINES = 100;
const MAX_MESSAGE_CHARS = 4000;
const MAX_STATUS_CHARS = 500;
const MAX_TITLE_CHARS = 200;
const MAX_EDITOR_CHARS = 64 * 1024;

/**
 * Plain-text stand-in for the TUI theme. Extensions such as pi-web-access call
 * `ctx.ui.theme.fg(...)` when they build widget lines; without a theme object those
 * calls would throw inside the extension. Every styling method returns the text
 * unchanged, so colours are an explicit visual downgrade (logged once) rather than a
 * fabricated theme.
 */
export const BROWSER_PLAIN_THEME = Object.freeze({
	name: "browser-plain",
	plain: true,
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	inverse: (text) => text,
	strikethrough: (text) => text,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
	getColorMode: () => "truecolor",
	getThinkingBorderColor: () => (text) => text,
	getBashModeBorderColor: () => (text) => text,
});

function safeText(value) {
	try {
		if (value === undefined || value === null) {
			return "";
		}
		return String(value);
	} catch {
		return "";
	}
}

function bounded(value, max) {
	return safeText(value).slice(0, max);
}

/**
 * Create the browser-driven UI context.
 *
 * @param {object} options
 * @param {import("../core/request-store.js").RequestStore} options.store
 * @param {(message: string) => void} [options.logger]
 * @returns {object} an `ExtensionUIContext`-shaped object plus host-introspection helpers
 */
export function createBrowserUIContext({ store, logger = () => {} } = {}) {
	if (!store || typeof store.create !== "function" || typeof store.createUnsupportedNotice !== "function") {
		throw new Error("createBrowserUIContext requires a request store");
	}

	let active = true;
	let terminalTitle = null;
	const statuses = new Map();
	const notices = [];
	const widgets = new Map();
	const working = { message: undefined, visible: undefined, indicator: undefined, hiddenThinkingLabel: undefined };
	const toolsExpanded = { value: false };
	const editorDraft = { text: "" };
	const degraded = new Set();

	function degrade(member, detail) {
		if (degraded.has(member)) {
			return;
		}
		degraded.add(member);
		logger(`browser UI: ctx.ui.${member} is not represented in the first-version browser page; the call was accepted as a safe no-op (${detail})`);
	}

	function dialog(kind, payload, opts) {
		if (!active) {
			return Promise.reject(new Error(`${INACTIVE_MESSAGE} (ctx.ui.${kind})`));
		}
		return store.create({ kind, ...payload, timeoutMs: opts?.timeout, signal: opts?.signal }).promise;
	}

	const uiContext = {
		select: (title, options, opts) => dialog("select", { title, options }, opts),
		confirm: (title, message, opts) => dialog("confirm", { title, message }, opts),
		input: (title, placeholder, opts) => dialog("input", { title, placeholder }, opts),
		editor: (title, prefill) => dialog("editor", { title, prefill }),
		custom: () => {
			if (!active) {
				return Promise.reject(new Error(`${INACTIVE_MESSAGE} (ctx.ui.custom)`));
			}
			// The factory owns its own terminal component state and is deliberately never called:
			// no browser answer path exists, so the original call fails instead of hanging.
			const noticeId = store.createUnsupportedNotice({
				title: "Custom terminal component prompt (ctx.ui.custom)",
				message: CUSTOM_UNSUPPORTED_MESSAGE,
			});
			logger(`browser UI: unsupported ctx.ui.custom prompt reported in the browser as notice ${noticeId}`);
			return Promise.reject(new Error(`${CUSTOM_UNSUPPORTED_MESSAGE} (browser notice ${noticeId})`));
		},
		notify(message, type) {
			const text = bounded(message, MAX_MESSAGE_CHARS);
			const notifyType = type === "warning" || type === "error" ? type : "info";
			notices.push({ message: text, type: notifyType });
			if (notices.length > MAX_NOTICES) {
				notices.splice(0, notices.length - MAX_NOTICES);
			}
			logger(`extension notice [${notifyType}]: ${text}`);
		},
		onTerminalInput() {
			degrade("onTerminalInput", "raw terminal input does not exist in a browser host");
			return () => {};
		},
		setStatus(key, text) {
			const name = bounded(key, 120);
			const previous = statuses.get(name);
			if (text === undefined) {
				statuses.delete(name);
				if (previous !== undefined) {
					logger(`extension status [${name}]: (cleared)`);
				}
				return;
			}
			const value = bounded(text, MAX_STATUS_CHARS);
			if (previous === value) {
				return;
			}
			statuses.set(name, value);
			while (statuses.size > MAX_STATUS_KEYS) {
				const oldest = statuses.keys().next().value;
				statuses.delete(oldest);
			}
			logger(`extension status [${name}]: ${value}`);
		},
		setWorkingMessage(message) {
			working.message = message === undefined ? undefined : bounded(message, MAX_MESSAGE_CHARS);
			degrade("setWorkingMessage", "the first-version page has no working-message row");
		},
		setWorkingVisible(visible) {
			working.visible = Boolean(visible);
			degrade("setWorkingVisible", "the first-version page has no working-loader row");
		},
		setWorkingIndicator(options) {
			working.indicator = options && typeof options === "object" ? options : undefined;
			degrade("setWorkingIndicator", "the first-version page has no working indicator");
		},
		setHiddenThinkingLabel(label) {
			working.hiddenThinkingLabel = label === undefined ? undefined : bounded(label, MAX_TITLE_CHARS);
			degrade("setHiddenThinkingLabel", "the first-version page does not relabel hidden thinking blocks");
		},
		setWidget(key, content, options) {
			const name = bounded(key, 120);
			if (content === undefined || Array.isArray(content)) {
				if (content === undefined) {
					widgets.delete(name);
				} else {
					widgets.set(name, {
						lines: content.slice(0, MAX_WIDGET_LINES).map((line) => bounded(line, MAX_MESSAGE_CHARS)),
						placement: options?.placement ?? "aboveEditor",
					});
					while (widgets.size > MAX_WIDGETS) {
						const oldest = widgets.keys().next().value;
						widgets.delete(oldest);
					}
				}
				degrade("setWidget", "widget lines are kept in host memory only; the page has no widget pane");
			} else {
				degrade("setWidget", "TUI component factories cannot be rendered by the browser host");
			}
		},
		setFooter(factory) {
			degrade("setFooter", factory === undefined ? "the host does not render a footer" : "TUI footer components cannot be rendered by the browser host");
		},
		setHeader(factory) {
			degrade("setHeader", factory === undefined ? "the host does not render a header" : "TUI header components cannot be rendered by the browser host");
		},
		setTitle(title) {
			terminalTitle = bounded(title, MAX_TITLE_CHARS);
			degrade("setTitle", "the host does not own a terminal or browser title");
		},
		pasteToEditor(text) {
			editorDraft.text = bounded(text, MAX_EDITOR_CHARS);
			degrade("pasteToEditor", "the browser composer is not wired to the editor draft yet");
		},
		setEditorText(text) {
			editorDraft.text = bounded(text, MAX_EDITOR_CHARS);
			degrade("setEditorText", "the browser composer is not wired to the editor draft yet");
		},
		getEditorText() {
			return editorDraft.text;
		},
		addAutocompleteProvider() {
			degrade("addAutocompleteProvider", "the browser composer has no autocomplete integration yet");
		},
		setEditorComponent(factory) {
			degrade("setEditorComponent", factory === undefined ? "there is no custom editor to restore" : "TUI editor components cannot be rendered by the browser host");
		},
		getEditorComponent() {
			return undefined;
		},
		get theme() {
			degrade("theme", "colors are plain text; no terminal theme is applied");
			return BROWSER_PLAIN_THEME;
		},
		getAllThemes() {
			degrade("getAllThemes", "the host does not load terminal themes");
			return [];
		},
		getTheme() {
			degrade("getTheme", "the host does not load terminal themes");
			return undefined;
		},
		setTheme() {
			degrade("setTheme", "theme switching needs the terminal TUI");
			return { success: false, error: "theme switching is not supported by the SDK browser host" };
		},
		getToolsExpanded() {
			return toolsExpanded.value;
		},
		setToolsExpanded(expanded) {
			toolsExpanded.value = Boolean(expanded);
			degrade("setToolsExpanded", "tool output folding is owned by the browser page");
		},

		// Host introspection (not part of ExtensionUIContext; harmless extra properties).
		support: Object.freeze({
			dialogs: UI_DIALOG_MEMBERS,
			unsupported: UI_UNSUPPORTED_MEMBERS,
			hostMemory: UI_HOST_MEMORY_MEMBERS,
			unavailable: UI_UNAVAILABLE_MEMBERS,
		}),
		isActive: () => active,
		/** Refuse further interactions; used by host shutdown before pending requests are ended. */
		deactivate: () => {
			active = false;
		},
		describeSupport: () => UI_SUPPORT_SUMMARY,
		getStatuses: () => new Map(statuses),
		getNotices: () => notices.map((notice) => ({ ...notice })),
		getWidget: (key) => {
			const widget = widgets.get(bounded(key, 120));
			return widget ? { lines: [...widget.lines], placement: widget.placement } : null;
		},
		getWorkingState: () => ({ ...working }),
		getEditorDraft: () => editorDraft.text,
		getTerminalTitle: () => terminalTitle,
	};

	return uiContext;
}
