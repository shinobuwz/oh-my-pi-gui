/**
 * Browser client for the Pi browser-interaction prototype.
 *
 * Vanilla ES module for host chrome. Assistant text mounts a React markdown island
 * (dsh MarkdownText) when the Vite build is present; otherwise it stays textContent.
 * Prompt cards and tool/thinking blocks always use textContent (never innerHTML).
 * The token is read from the URL fragment (#t=…) and kept in sessionStorage; it is
 * sent to the loopback bridge as an Authorization header only.
 */

const TOKEN_STORAGE_KEY = "pi-browser-ui-token";
const POLL_INTERVAL_MS = 600;
const MAX_POLL_INTERVAL_MS = 5000;

const elements = {
	connection: document.getElementById("connection"),
	pageTabChat: document.getElementById("page-tab-chat"),
	pageTabSubagents: document.getElementById("page-tab-subagents"),
	chatPage: document.getElementById("chat-page"),
	subagentsPage: document.getElementById("subagents-page"),
	statusState: document.getElementById("status-state"),
	statusCwd: document.getElementById("status-cwd"),
	statusBranch: document.getElementById("status-branch"),
	statusTokens: document.getElementById("status-tokens"),
	statusContext: document.getElementById("status-context"),
	subagentsState: document.getElementById("subagents-state"),
	subagentsTag: document.getElementById("subagents-tag"),
	subagentsStatus: document.getElementById("subagents-status"),
	subagentsRefresh: document.getElementById("subagents-refresh"),
	subagentsFleet: document.getElementById("subagents-fleet"),
	subagentsFleetEmpty: document.getElementById("subagents-fleet-empty"),
	subagentsAsync: document.getElementById("subagents-async"),
	subagentsAsyncEmpty: document.getElementById("subagents-async-empty"),
	requests: document.getElementById("requests"),
	empty: document.getElementById("empty"),
	auth: document.getElementById("auth"),
	authForm: document.getElementById("auth-form"),
	authInput: document.getElementById("auth-token"),
	authMessage: document.getElementById("auth-message"),
	reload: document.getElementById("reload-form"),
	reloadButton: document.getElementById("reload-button"),
	reloadState: document.getElementById("reload-state"),
	template: document.getElementById("card-template"),
	chatHistory: document.getElementById("chat-history"),
	chatEmpty: document.getElementById("chat-empty"),
	chatForm: document.getElementById("chat-form"),
	chatInput: document.getElementById("chat-input"),
	chatDelivery: document.getElementById("chat-delivery"),
	chatSend: document.getElementById("chat-send"),
	chatStop: document.getElementById("chat-stop"),
	chatStatus: document.getElementById("chat-status"),
	chatPhase: document.getElementById("chat-phase"),
	controlsState: document.getElementById("controls-state"),
	modelCurrent: document.getElementById("model-current"),
	modelForm: document.getElementById("model-form"),
	modelSelect: document.getElementById("model-select"),
	modelStatus: document.getElementById("model-status"),
	thinkingForm: document.getElementById("thinking-form"),
	thinkingSelect: document.getElementById("thinking-select"),
	thinkingStatus: document.getElementById("thinking-status"),
};

if (!elements.chatDelivery.value) {
	// The real select defaults to its first option; the strict test DOM does not
	// parse index.html, so make the same default explicit for both environments.
	elements.chatDelivery.value = "normal";
}

const state = {
	token: readToken(),
	revision: -1,
	generation: null,
	// The page the reader chose. Nothing but a click (or its keyboard equivalent) changes
	// it: polls, refreshes and reload generations update data in place, on whatever page
	// is showing.
	page: "chat",
	pollInterval: POLL_INTERVAL_MS,
	rendered: new Map(),
	stopped: false,
	reloading: false,
	chatRevision: null,
	chatMessages: new Map(),
	chatOrder: [],
	chatRendered: new Map(),
	chatRenderedRevisions: new Map(),
	chat: null,
	chatLastError: null,
	chatSending: false,
	controls: null,
	modelSending: false,
	thinkingSending: false,
	subagentsSnapshot: null,
	subagentsGeneration: null,
	subagentsRefreshing: false,
	subagentDetails: new Map(),
	subagentInspects: new Map(),
	subagentInspectNodes: new Map(),
	subagentOpenChildren: new Map(),
};

function readToken() {
	const match = /(?:^|[#&])t=([A-Za-z0-9._-]+)/.exec(location.hash);
	if (match) {
		sessionStorage.setItem(TOKEN_STORAGE_KEY, match[1]);
		// Keep the token out of the visible URL and out of future referrers.
		history.replaceState(null, "", `${location.pathname}${location.search}`);
		return match[1];
	}
	return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

function setConnection(text, stateName) {
	elements.connection.textContent = text;
	elements.connection.dataset.state = stateName;
}

function showAuth(message) {
	elements.auth.classList.remove("hidden");
	if (message) {
		elements.authMessage.textContent = message;
	}
}

function hideAuth() {
	elements.auth.classList.add("hidden");
}

/* The shell has two pages. Only the selected panel is in the layout — the other one is
   `display: none`, so its controls leave the tab order and the accessibility tree with it
   — and only the selected tab stays in the tab order: Tab reaches the row once, then the
   arrow keys (or Home/End) move within it, as the tab pattern expects. */
const PAGES = [
	{ name: "chat", tab: elements.pageTabChat, panel: elements.chatPage },
	{ name: "subagents", tab: elements.pageTabSubagents, panel: elements.subagentsPage },
];

function selectPage(name, { focusTab = false } = {}) {
	const target = PAGES.find((page) => page.name === name) ?? PAGES[0];
	state.page = target.name;
	for (const page of PAGES) {
		const active = page === target;
		page.tab.setAttribute("aria-selected", active ? "true" : "false");
		page.tab.tabIndex = active ? 0 : -1;
		page.panel.classList.toggle("hidden", !active);
		if (active && focusTab && typeof page.tab.focus === "function") {
			page.tab.focus();
		}
	}
}

async function api(path, options = {}) {
	const headers = { ...(options.headers ?? {}) };
	headers.Authorization = `Bearer ${state.token}`;
	if (options.body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	return fetch(path, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

function cardFor(request) {
	const fragment = elements.template.content.cloneNode(true);
	const card = fragment.querySelector(".card");
	card.dataset.kind = request.kind;
	card.dataset.id = request.id;
	if (request.unsupported) {
		card.dataset.unsupported = "true";
	}
	card.querySelector(".card-title").textContent = request.title || `${request.kind} prompt`;
	const message = card.querySelector(".card-message");
	if (request.unsupported) {
		message.textContent = `Not supported by the browser prototype: this interaction was terminated without approval. ${
			request.unsupportedReason || ""
		}`.trim();
	} else {
		message.textContent = request.message || "";
	}
	const form = card.querySelector(".card-form");
	const submitForm = (valueFactory) => {
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			submit(card, request.id, valueFactory(card));
		});
	};
	switch (request.kind) {
		case "confirm": {
			const yes = document.createElement("button");
			yes.type = "submit";
			yes.className = "primary";
			yes.textContent = "Yes";
			const no = document.createElement("button");
			no.type = "button";
			no.textContent = "No";
			no.addEventListener("click", () => submit(card, request.id, false));
			form.append(yes, no);
			submitForm(() => true);
			break;
		}
		case "select": {
			const options = Array.isArray(request.options) ? request.options : [];
			options.forEach((option) => {
				const label = document.createElement("label");
				const input = document.createElement("input");
				input.type = "radio";
				input.name = `option-${request.id}`;
				input.value = option;
				input.required = true;
				const text = document.createElement("span");
				text.textContent = option;
				label.append(input, text);
				form.append(label);
			});
			const submit = document.createElement("button");
			submit.type = "submit";
			submit.className = "primary";
			submit.textContent = "Submit selection";
			form.append(submit);
			submitForm((node) => {
				const checked = node.querySelector("input[type=radio]:checked");
				return checked?.value;
			});
			break;
		}
		case "input": {
			const input = document.createElement("input");
			input.type = "text";
			input.placeholder = request.placeholder || "";
			input.maxLength = 4096;
			input.required = true;
			const submit = document.createElement("button");
			submit.type = "submit";
			submit.className = "primary";
			submit.textContent = "Submit text";
			form.append(input, submit);
			submitForm((node) => node.querySelector("input[type=text]").value);
			break;
		}
		case "editor": {
			const textarea = document.createElement("textarea");
			textarea.value = request.prefill || "";
			textarea.maxLength = 65536;
			const submit = document.createElement("button");
			submit.type = "submit";
			submit.className = "primary";
			submit.textContent = "Submit text";
			form.append(textarea, submit);
			submitForm((node) => node.querySelector("textarea").value);
			break;
		}
		default: {
			// Unsupported interaction: the host already terminated it without approval.
			form.remove();
			break;
		}
	}
	const cancelButton = card.querySelector(".cancel");
	if (request.unsupported) {
		cancelButton.textContent = "Dismiss notice";
		cancelButton.classList.add("primary");
		cancelButton.addEventListener("click", () => submit(card, request.id, undefined, "dismiss"));
	} else {
		cancelButton.addEventListener("click", () => submit(card, request.id, undefined, "cancel"));
	}
	updateMeta(card, request);
	return card;
}

function updateMeta(card, request) {
	const parts = [request.kind];
	if (request.deadlineAt) {
		const remaining = Math.max(0, Math.round((request.deadlineAt - Date.now()) / 1000));
		parts.push(`host timeout in ${remaining}s`);
	}
	if (request.unsupported) {
		parts.push("no browser answer path");
	} else {
		parts.push("waiting for your explicit answer");
	}
	card.querySelector(".card-meta").textContent = parts.join(" · ");
}

function setResult(card, text, stateName) {
	const result = card.querySelector(".card-result");
	result.textContent = text;
	result.dataset.state = stateName;
}

async function submit(card, id, value, action = "answer") {
	const buttons = card.querySelectorAll("button");
	buttons.forEach((button) => {
		button.disabled = true;
	});
	if (action === "answer" && value === undefined) {
		setResult(card, "Choose a value first.", "error");
		buttons.forEach((button) => {
			button.disabled = false;
		});
		return;
	}
	try {
		const response = await api("/api/answer", { method: "POST", body: { id, action, value } });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const code = payload?.error?.code ?? `http_${response.status}`;
			const message = payload?.error?.message ?? "rejected";
			const hint = code === "reloading" || code === "stale_generation" ? " — the session reloaded; this prompt is no longer valid." : "";
			setResult(card, `Rejected (${code}): ${message}${hint}`, "error");
			buttons.forEach((button) => {
				button.disabled = false;
			});
			if (response.status === 401) {
				handleUnauthorized();
			}
			return;
		}
		const summary = action === "cancel" ? "Cancelled (non-approval result)" : "Submitted to the host";
		setResult(card, summary, "ok");
		await poll();
	} catch (error) {
		setResult(card, `Network error: ${error instanceof Error ? error.message : String(error)}`, "error");
		buttons.forEach((button) => {
			button.disabled = false;
		});
		setConnection("Disconnected from the Pi host — retrying…", "offline");
	}
}

function setChatStatus(text, stateName = "") {
	elements.chatStatus.textContent = text;
	elements.chatStatus.dataset.state = stateName;
}

function setControlStatus(element, text, stateName = "") {
	element.textContent = text;
	element.dataset.state = stateName;
}

function finiteNonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Compactly format only finite, non-negative status numbers. */
export function formatStatusNumber(value) {
	const number = finiteNonNegative(value);
	if (number === null) {
		return "Unknown";
	}
	if (number < 1000) {
		return Number.isInteger(number) ? String(number) : number.toFixed(1);
	}
	if (number < 10000) {
		return `${(number / 1000).toFixed(1)}k`;
	}
	if (number < 1000000) {
		return `${Math.round(number / 1000)}k`;
	}
	if (number < 10000000) {
		return `${(number / 1000000).toFixed(1)}M`;
	}
	return `${Math.round(number / 1000000)}M`;
}

function statusText(value) {
	return typeof value === "string" && value.length > 0 ? value : "Unknown";
}

function statusBranchText(git) {
	if (!git || typeof git !== "object") {
		return "Unknown";
	}
	const branch = statusText(git.branch);
	if (branch === "Unknown") {
		return "Unknown";
	}
	return git.reason === "detached_head" ? `${branch} (detached)` : branch;
}

function statusTokensText(tokens) {
	if (!tokens || typeof tokens !== "object") {
		return "Unknown";
	}
	return [
		`in ${formatStatusNumber(tokens.input)}`,
		`out ${formatStatusNumber(tokens.output)}`,
		`read ${formatStatusNumber(tokens.cacheRead)}`,
		`write ${formatStatusNumber(tokens.cacheWrite)}`,
		`total ${formatStatusNumber(tokens.total)}`,
	].join(" · ");
}

function statusContextText(contextUsage) {
	if (!contextUsage || typeof contextUsage !== "object") {
		return "tokens Unknown · window Unknown · usage Unknown";
	}
	const percent = finiteNonNegative(contextUsage.percent);
	return [
		`tokens ${formatStatusNumber(contextUsage.tokens)}`,
		`window ${formatStatusNumber(contextUsage.contextWindow)}`,
		`usage ${percent === null ? "Unknown" : `${percent.toFixed(1)}%`}`,
	].join(" · ");
}

/** Render the read-only current-session status with textContent only. */
function renderStatus(status) {
	if (!status || status.available !== true) {
		elements.statusState.textContent = "Unavailable";
		elements.statusCwd.textContent = "Unknown";
		elements.statusBranch.textContent = "Unknown";
		elements.statusTokens.textContent = "Unknown";
		elements.statusContext.textContent = "tokens Unknown · window Unknown · usage Unknown";
		elements.statusState.dataset.state = "unavailable";
		return;
	}
	elements.statusState.textContent = state.reloading ? "Reloading…" : "Connected";
	elements.statusState.dataset.state = state.reloading ? "waiting" : "online";
	elements.statusCwd.textContent = statusText(status.cwd);
	elements.statusBranch.textContent = statusBranchText(status.git);
	elements.statusTokens.textContent = statusTokensText(status.tokens);
	elements.statusContext.textContent = statusContextText(status.contextUsage);
}

function clearElement(element) {
	for (const child of [...(element?.children ?? [])]) {
		child.remove();
	}
	if (element) {
		element.textContent = "";
	}
}

function subagentTime(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return "Unknown";
	}
	try {
		return new Date(value).toISOString();
	} catch {
		return "Unknown";
	}
}

function subagentValue(value) {
	return typeof value === "string" && value.length > 0 ? value : "Unknown";
}

function subagentTokensText(tokens) {
	if (!tokens || typeof tokens !== "object") {
		return "Unknown";
	}
	const parts = [
		`in ${formatStatusNumber(tokens.input)}`,
		`out ${formatStatusNumber(tokens.output)}`,
		`total ${formatStatusNumber(tokens.total)}`,
	];
	// `window` is the child's current context size and `windowPeak` its peak: live context
	// pressure is the part of a child's internal state that matters while it runs.
	if (typeof tokens.window === "number") {
		parts.push(`context ${formatStatusNumber(tokens.window)}`);
	}
	if (typeof tokens.windowPeak === "number") {
		parts.push(`peak ${formatStatusNumber(tokens.windowPeak)}`);
	}
	return parts.join(" · ");
}

function appendSubagentText(parent, className, text) {
	const node = document.createElement("p");
	node.className = className;
	node.textContent = text;
	parent.append(node);
	return node;
}

/* Fleet entries carry only what pi-subagents publishes: `role` exists for async chain steps
   and `state` has no field in the fleet DTO at all, so an absent value is rendered as nothing
   rather than as "Unknown". An entry in this list is active work by construction. */
function renderFleetEntry(entry) {
	const card = document.createElement("article");
	card.className = "subagent-entry";
	const title = document.createElement("h4");
	title.className = "subagent-entry-title";
	title.textContent = `Fleet entry ${subagentValue(entry.key)}`;
	card.append(title);
	const parts = [`agent: ${subagentValue(entry.agent)}`];
	for (const [label, value] of [["role", entry.role], ["model", entry.model], ["effort", entry.effort], ["state", entry.state]]) {
		if (typeof value === "string" && value.length > 0) {
			parts.push(`${label}: ${value}`);
		}
	}
	if (entry.tokens && typeof entry.tokens === "object") {
		parts.push(`tokens: ${subagentTokensText(entry.tokens)}`);
	}
	if (typeof entry.startedAt === "number") {
		parts.push(`started: ${subagentTime(entry.startedAt)}`);
	}
	appendSubagentText(card, "subagent-entry-meta", parts.join(" · "));
	if (entry.goal) {
		appendSubagentText(card, "subagent-entry-meta", `goal: ${entry.goal}`);
	}
	return card;
}

function summaryText(summary) {
	if (!summary || typeof summary !== "object") return "Unknown";
	return [
		summary.id ? `id ${summary.id}` : "",
		summary.label ? `label ${summary.label}` : "",
		summary.state ? `state ${summary.state}` : "",
		summary.mode ? `mode ${summary.mode}` : "",
		summary.model ? `model ${summary.model}` : "",
		summary.status ? `status ${summary.status}` : "",
		summary.success === true ? "success" : summary.success === false ? "failed" : "",
	].filter(Boolean).join(" · ") || "Unknown";
}

function renderSummaryList(parent, title, values, className) {
	if (!Array.isArray(values) || values.length === 0) return;
	const details = document.createElement("details");
	details.className = className;
	const summary = document.createElement("summary");
	summary.textContent = `${title} (${values.length})`;
	const list = document.createElement("ul");
	for (const value of values) {
		const item = document.createElement("li");
		item.className = className === "subagent-children" ? "subagent-child-summary" : "subagent-result-summary";
		item.textContent = summaryText(value);
		list.append(item);
	}
	details.append(summary, list);
	parent.append(details);
}

function detailForRun(card, id) {
	let detail = card.querySelector(".subagent-detail");
	if (!detail) {
		detail = document.createElement("details");
		detail.className = "subagent-detail";
		detail.dataset.id = id;
		card.append(detail);
	}
	return detail;
}

function renderSubagentDetail(card, id, payload) {
	const detail = detailForRun(card, id);
	clearElement(detail);
	detail.open = true;
	const summary = document.createElement("summary");
	summary.textContent = "Transcript detail (bounded tail)";
	const text = document.createElement("pre");
	text.textContent = typeof payload?.text === "string" && payload.text.length > 0 ? payload.text : "No transcript text was returned.";
	detail.append(summary, text);
	if (payload?.summary && typeof payload.summary === "object") {
		appendSubagentText(detail, "subagent-run-meta", `Summary: ${summaryText(payload.summary)}`);
	}
}

async function requestSubagentDetail(card, id, button, resultElement) {
	if (state.generation === null || typeof id !== "string" || id.length === 0) {
		resultElement.textContent = "The current async run is not available.";
		resultElement.dataset.state = "error";
		return;
	}
	button.disabled = true;
	resultElement.textContent = "Loading transcript detail…";
	resultElement.dataset.state = "waiting";
	try {
		const response = await api("/api/subagents/details", {
			method: "POST",
			body: { generation: state.generation, id },
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const code = payload?.error?.code ?? `http_${response.status}`;
			resultElement.textContent = `Transcript unavailable (${code}): ${payload?.error?.message ?? "unknown reason"}`;
			resultElement.dataset.state = "error";
			if (response.status === 401) handleUnauthorized();
			return;
		}
		renderSubagentDetail(card, id, payload);
		state.subagentDetails.set(id, payload);
		resultElement.textContent = "Transcript detail loaded.";
		resultElement.dataset.state = "ok";
	} catch (error) {
		resultElement.textContent = `Transcript request failed: ${error instanceof Error ? error.message : String(error)}`;
		resultElement.dataset.state = "error";
	} finally {
		button.disabled = false;
	}
}

/*
 * Structured subagent inspection (read-only).
 *
 * `POST /api/subagents/inspect` answers with the host's bounded projection of the child
 * session (task, messages, final output, truncation flags). The panel stays collapsed and
 * sends nothing until the user clicks its own toggle, and everything it shows is built
 * with textContent/DOM only, so host text is never parsed as markup. The raw artifact tail
 * ("View transcript") keeps its own path and stays the fallback when this view cannot
 * answer.
 */

/**
 * One line of copy per documented failure code. Timeout, busy, unavailable and foreign
 * sessions must stay distinguishable instead of collapsing into one "failed" message.
 */
const INSPECT_ERROR_TEXT = Object.freeze({
	invalid_body: ["Invalid request", "the host rejected the inspection request as invalid"],
	unauthorized: ["Not authorized", "this page is no longer accepted by the running Pi process"],
	bad_origin: ["Blocked", "the host rejected the request origin"],
	foreign_session: ["Other session", "this run belongs to a different Pi session"],
	not_found: ["Not found", "this run is neither in the current subagent snapshot nor readable as a transcript"],
	stale_generation: ["Stale session", "the session generation changed; wait for the new binding"],
	stale: ["Stale snapshot", "the subagent snapshot is stale; refresh the subagents card and retry"],
	reloading: ["Reloading", "the session is reloading; wait for the new generation"],
	inspect_busy: ["Busy", "another structured inspection is already in flight; try again in a moment"],
	no_active_session: ["No session", "no Pi session is active in this host"],
	inspect_unavailable: ["Unavailable", "the pi-subagents inspect command is not available in this session"],
	commands_unavailable: ["Unavailable", "the session did not expose its command list, so the inspection was refused"],
	inspect_timeout: ["Timed out", "the pi-subagents inspect command did not answer in time"],
	no_generation: ["Not connected", "the page has no current session generation yet"],
	network: ["Network error", "the page could not reach the Pi host"],
});

let inspectPanelSeq = 0;

function inspectFailureText(code, message) {
	const known = INSPECT_ERROR_TEXT[code];
	const label = known ? known[0] : "Failed";
	const text = known ? known[1] : "the host reported an unrecognized inspection failure";
	const detail = typeof message === "string" && message.length > 0 ? message : "";
	return { detail, line: `${label} (${code || "inspect_failed"}): ${text}` };
}

const PAGE_INSPECT_KEY_PREFIX = "run:";
const CHAT_INSPECT_KEY_PREFIX = "chat:";

function inspectKey(runId, childId, prefix = "run") {
	const scope = prefix ? `${prefix}:` : "";
	return childId ? `${scope}${runId}#${childId}` : `${scope}${runId}`;
}

function inspectEntry(key, runId, { open = false } = {}) {
	const existing = state.subagentInspects.get(key);
	if (existing) {
		existing.runId = runId;
		return existing;
	}
	const entry = { runId, open, status: "idle", payload: null, code: null, message: null, session: null };
	state.subagentInspects.set(key, entry);
	return entry;
}

/** Fake-DOM-safe attachment test: real nodes expose `isConnected`, stubs expose `parent`. */
function isAttached(node) {
	return typeof node?.isConnected === "boolean" ? node.isConnected === true : Boolean(node?.parent);
}

/**
 * Visual kind of one message row. pi-subagents marks tool calls with `kind: "toolCall"`,
 * but tool results usually arrive as `kind: "text"` with `role: "toolResult"`, so both
 * signals decide how the row is drawn.
 */
function inspectMessageKind(message) {
	if (message.kind === "toolCall") {
		return "toolCall";
	}
	const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
	if (message.kind === "toolResult" || role === "toolresult" || role === "tool") {
		return "toolResult";
	}
	return "text";
}

function inspectMessageLabel(message, kind) {
	const role = subagentValue(message.role);
	const name = typeof message.name === "string" && message.name.length > 0 ? message.name : "";
	if (kind === "toolCall") {
		return `${role} · tool call: ${name || "tool"}`;
	}
	if (kind === "toolResult") {
		return `tool result${name ? `: ${name}` : ""}${message.isError === true ? " (error)" : ""}`;
	}
	return role;
}

function appendInspectHeading(parent, text, suffix = "") {
	return appendSubagentText(parent, "subagent-inspect-heading", suffix ? `${text} · ${suffix}` : text);
}

function appendInspectNote(parent, text) {
	const note = appendSubagentText(parent, "subagent-inspect-note", text);
	note.dataset.state = "warning";
	return note;
}

function inspectTruncated(inspect) {
	const truncated = inspect.truncated && typeof inspect.truncated === "object" ? inspect.truncated : {};
	return {
		task: truncated.task === true,
		messages: Number.isSafeInteger(truncated.messages) && truncated.messages > 0 ? truncated.messages : 0,
		finalOutput: truncated.finalOutput === true,
	};
}

function renderInspectMessages(body, inspect, truncated) {
	const messages = Array.isArray(inspect.messages) ? inspect.messages : [];
	appendInspectHeading(body, "Messages", messages.length > 0 ? `${messages.length} shown` : "");
	if (truncated.messages > 0) {
		const count = truncated.messages;
		appendInspectNote(body, `Earlier ${count} message${count === 1 ? " was" : "s were"} dropped by the host's bound; this list starts later.`);
	}
	if (messages.length === 0) {
		// A running child often has no readable session file yet: an empty list is a normal
		// empty state, not a failure, and must not be dressed up as one.
		const running = typeof inspect.status === "string" && inspect.status.toLowerCase() === "running";
		appendSubagentText(
			body,
			"subagent-inspect-empty",
			running
				? "This run is still running and its child session has no readable messages yet. An empty list here is normal, not a failure."
				: "The host returned no messages for this run.",
		);
		return;
	}
	const list = document.createElement("ol");
	list.className = "subagent-inspect-messages";
	for (const message of messages) {
		if (!message || typeof message !== "object") {
			continue;
		}
		const item = document.createElement("li");
		item.className = "subagent-inspect-message";
		const kind = inspectMessageKind(message);
		item.dataset.kind = kind;
		if (message.isError === true) {
			item.dataset.state = "error";
		}
		appendSubagentText(item, "subagent-inspect-label", inspectMessageLabel(message, kind));
		appendSubagentText(item, "subagent-inspect-text", typeof message.text === "string" && message.text.length > 0 ? message.text : "(empty message)");
		list.append(item);
	}
	body.append(list);
}

function renderInspectContent(body, inspect) {
	if (inspect.kind === "transcript") {
		renderInspectTranscript(body, inspect);
		return;
	}
	const truncated = inspectTruncated(inspect);
	const task = typeof inspect.task === "string" && inspect.task.length > 0 ? inspect.task : "";
	appendInspectHeading(body, "Task");
	if (truncated.task) {
		appendInspectNote(body, "The task text was truncated by the host's bound.");
	}
	if (task) {
		appendSubagentText(body, "subagent-inspect-task", task);
	} else {
		appendSubagentText(body, "subagent-inspect-empty", "Unknown — no task text was reported for this run.");
	}
	renderInspectMessages(body, inspect, truncated);
	const finalOutput = typeof inspect.finalOutput === "string" && inspect.finalOutput.length > 0 ? inspect.finalOutput : "";
	appendInspectHeading(body, "Final output");
	if (truncated.finalOutput) {
		appendInspectNote(body, "The final output was truncated by the host's bound.");
	}
	if (finalOutput) {
		appendSubagentText(body, "subagent-inspect-final", finalOutput);
	} else {
		appendSubagentText(body, "subagent-inspect-empty", "Unknown — no final output was reported for this run.");
	}
}

/*
 * The extension serves blocking (foreground) delegations as text only: their transcript is
 * what pi-subagents can answer with, so the panel shows it as-is instead of pretending a
 * structured view exists. Path-looking lines are dropped by the host's redaction, which is
 * the same rule the rest of the panel follows.
 */
function renderInspectTranscript(body, inspect) {
	const text = typeof inspect.text === "string" ? inspect.text : "";
	const lines = Number.isSafeInteger(inspect.lines) && inspect.lines > 0 ? inspect.lines : 0;
	appendInspectHeading(body, "Child transcript", lines > 0 ? `last ${lines} lines` : "");
	appendSubagentText(
		body,
		"subagent-inspect-empty",
		"This run is a blocking (foreground) delegation. pi-subagents inspects async runs structurally and answers foreground runs with this transcript instead.",
	);
	if (text) {
		appendSubagentText(body, "subagent-inspect-transcript", text);
	} else {
		appendSubagentText(body, "subagent-inspect-empty", "The host returned an empty transcript for this run.");
	}
}

/** Repaint one existing panel from its cached entry (never sends a request by itself). */
function paintInspect(nodes) {
	const entry = state.subagentInspects.get(nodes.key);
	if (!entry) {
		return;
	}
	const open = entry.open === true;
	nodes.toggle.textContent = open ? "Hide inspector" : "Inspect";
	nodes.toggle.setAttribute("aria-expanded", open ? "true" : "false");
	nodes.panel.classList.toggle("hidden", !open);
	nodes.panel.setAttribute("aria-busy", entry.status === "loading" ? "true" : "false");
	clearElement(nodes.status);
	clearElement(nodes.body);
	nodes.status.dataset.state = "";
	if (entry.status === "idle") {
		return;
	}
	if (entry.status === "loading") {
		nodes.status.dataset.state = "waiting";
		nodes.status.textContent = "Requesting the read-only view…";
		return;
	}
	if (entry.status === "error") {
		const failure = inspectFailureText(entry.code, entry.message);
		nodes.status.dataset.state = "error";
		nodes.status.textContent = `Inspector unavailable · ${failure.line}`;
		appendSubagentText(nodes.body, "subagent-inspect-note", `Host reply: ${failure.detail || "no detail was returned"}`);
		return;
	}
	const inspect = entry.payload && typeof entry.payload === "object" ? entry.payload : {};
	const parts = [];
	if (inspect.kind === "transcript") {
		parts.push("transcript");
	}
	if (typeof inspect.status === "string" && inspect.status.length > 0) {
		parts.push(`status: ${inspect.status}`);
	}
	if (typeof inspect.runId === "string" && inspect.runId.length > 0) {
		parts.push(`run: ${inspect.runId}`);
	}
	if (typeof inspect.label === "string" && inspect.label.length > 0) {
		parts.push(`label: ${inspect.label}`);
	}
	if (nodes.childId) {
		parts.push(`child: ${nodes.childId}`);
	}
	if (parts.length > 0) {
		appendSubagentText(nodes.body, "subagent-inspect-meta", parts.join(" · "));
	}
	renderInspectContent(nodes.body, inspect);
	// A blocking (foreground) run has no structured view, but its child session file holds the
	// full conversation the extension only summarises — show that as the content.
	if (inspect.kind === "transcript") {
		renderChildSession(nodes, entry);
	}
}

function emptyChildSession() {
	return { status: "idle", messages: [], cursor: null, earlier: false, window: null, code: null, message: null };
}

/**
 * Render the child session page this entry has, if any: the newest page first, with the records
 * drawn by the chat renderer (same rows, same thinking/tool blocks) and one explicit action for
 * the page before it.
 */
function renderChildSession(nodes, entry) {
	const session = entry.session;
	if (!session || session.status === "idle") {
		return;
	}
	const body = nodes.body;
	if (session.status === "loading" && session.messages.length === 0) {
		appendSubagentText(body, "subagent-inspect-empty", "Loading the child session from disk…");
		return;
	}
	if (session.status === "error") {
		const failure = inspectFailureText(session.code, session.message);
		appendInspectHeading(body, "Child session");
		appendSubagentText(body, "subagent-inspect-empty", `Unavailable · ${failure.line}`);
		if (failure.detail) {
			appendSubagentText(body, "subagent-inspect-note", `Host reply: ${failure.detail}`);
		}
		return;
	}
	const skipped = Number.isSafeInteger(session.window?.skipped) && session.window.skipped > 0 ? session.window.skipped : 0;
	appendInspectHeading(body, "Child session", `${session.messages.length} record${session.messages.length === 1 ? "" : "s"}${session.window?.truncatedHead ? " · file tail" : ""}`);
	if (session.earlier && Number.isSafeInteger(session.cursor)) {
		const more = document.createElement("button");
		more.type = "button";
		more.className = "subagent-inspect-more ghost small";
		more.textContent = "Load older records";
		more.addEventListener("click", () => requestChildSession(nodes, { before: session.cursor }));
		body.append(more);
	}
	if (session.messages.length === 0) {
		appendSubagentText(body, "subagent-inspect-empty", "The child session file holds no conversation records yet.");
	}
	for (const message of session.messages) {
		body.append(chatCardFor(message));
	}
	if (skipped > 0) {
		appendSubagentText(body, "subagent-inspect-empty", `${skipped} record${skipped === 1 ? "" : "s"} in this window are session metadata or could not be read.`);
	}
}

/**
 * Read one page of the run's child session (host-side disk read, bounded and derived from the
 * run id — the page never names a path). `before` walks one page further back.
 */
async function requestChildSession(nodes, { before = null } = {}) {
	const entry = state.subagentInspects.get(nodes.key);
	if (!entry || state.generation === null) {
		return;
	}
	const session = entry.session ?? (entry.session = emptyChildSession());
	if (session.status === "loading") {
		return;
	}
	session.status = "loading";
	if (before === null) {
		session.messages = [];
		session.cursor = null;
		session.earlier = false;
		session.window = null;
		session.code = null;
		session.message = null;
	}
	repaintInspect(nodes.key);
	try {
		const response = await api("/api/subagents/session", {
			method: "POST",
			body: { generation: state.generation, id: entry.runId, index: 0, ...(before === null ? {} : { before }) },
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			session.status = "error";
			session.code = payload?.error?.code ?? `http_${response.status}`;
			session.message = payload?.error?.message ?? "unknown reason";
			if (response.status === 401) {
				handleUnauthorized();
			}
			repaintInspect(nodes.key);
			return;
		}
		const messages = Array.isArray(payload?.messages) ? payload.messages : [];
		session.messages = before === null ? messages : [...messages, ...session.messages];
		session.cursor = Number.isSafeInteger(payload?.cursor) ? payload.cursor : null;
		session.earlier = payload?.earlier === true;
		session.window = payload?.window && typeof payload.window === "object" ? payload.window : null;
		session.code = null;
		session.message = null;
		session.status = "ready";
		repaintInspect(nodes.key);
	} catch (error) {
		session.status = "error";
		session.code = "network";
		session.message = error instanceof Error ? error.message : String(error);
		repaintInspect(nodes.key);
	}
}

function repaintInspect(key) {
	const nodes = state.subagentInspectNodes.get(key);
	if (nodes && isAttached(nodes.panel)) {
		paintInspect(nodes);
	}
}

function setInspectFailure(key, code, message) {
	const entry = state.subagentInspects.get(key);
	if (!entry) {
		return;
	}
	entry.status = "error";
	entry.payload = null;
	entry.code = code;
	entry.message = message;
	repaintInspect(key);
}

async function requestInspect(nodes) {
	const entry = state.subagentInspects.get(nodes.key);
	if (!entry) {
		return;
	}
	if (state.generation === null) {
		setInspectFailure(nodes.key, "no_generation", "the page is not attached to a session generation yet");
		return;
	}
	const body = { generation: state.generation, id: entry.runId };
	if (nodes.childId) {
		body.childId = nodes.childId;
	}
	try {
		const response = await api("/api/subagents/inspect", { method: "POST", body });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const code = payload?.error?.code ?? `http_${response.status}`;
			setInspectFailure(nodes.key, code, payload?.error?.message ?? "unknown reason");
			if (response.status === 401) {
				handleUnauthorized();
			}
			return;
		}
		const inspect = payload?.inspect;
		if (!inspect || typeof inspect !== "object") {
			setInspectFailure(nodes.key, "inspect_failed", "the host answered without a structured payload");
			return;
		}
		// A late answer must never be dropped silently: if the entry was pruned while the request
		// was in flight, re-create it open so the panel that asked for it still shows the result.
		const current = state.subagentInspects.get(nodes.key) ?? inspectEntry(nodes.key, entry.runId, { open: true });
		current.status = "done";
		current.payload = inspect;
		current.code = null;
		current.message = null;
		if (inspect.kind === "transcript") {
			// The extension can only summarise a blocking run; the content lives in its child
			// session file, so the panel reads that next (and says so while it waits).
			current.session = emptyChildSession();
			await requestChildSession(nodes);
			return;
		}
		repaintInspect(nodes.key);
	} catch (error) {
		setInspectFailure(nodes.key, "network", error instanceof Error ? error.message : String(error));
	}
}

function toggleInspect(nodes) {
	const entry = state.subagentInspects.get(nodes.key);
	if (!entry) {
		return;
	}
	if (entry.open === true) {
		entry.open = false;
		paintInspect(nodes);
		return;
	}
	entry.open = true;
	// Every genuine open takes a fresh snapshot: the panel has no refresh control and shows a
	// point-in-time answer, so reusing a previous one would make a running run look frozen.
	entry.status = "loading";
	entry.payload = null;
	entry.code = null;
	entry.message = null;
	paintInspect(nodes);
	requestInspect(nodes);
}

/** Collapsed-by-default toggle + panel for one run or one id-bearing child node. */
function buildInspectPanel({ runId, childId = null, label, keyPrefix = "run" }) {
	const key = inspectKey(runId, childId, keyPrefix);	inspectEntry(key, runId);
	inspectPanelSeq += 1;
	const panelId = `subagent-inspect-panel-${inspectPanelSeq}`;
	const container = document.createElement("div");
	container.className = "subagent-inspect";
	container.dataset.runId = runId;
	if (childId) {
		container.dataset.childId = childId;
		container.dataset.kind = "child";
	}
	const toggle = document.createElement("button");
	toggle.type = "button";
	// One read-only inspector per run: the panel renders whatever pi-subagents can serve for
	// the run the row named — a structured view for async runs, a text transcript for blocking
	// (foreground) ones — and the raw artifact transcript stays the page's separate fallback.
	toggle.className = "subagent-inspect-toggle ghost small";
	toggle.setAttribute("aria-controls", panelId);
	const panel = document.createElement("div");
	panel.id = panelId;
	panel.className = "subagent-inspect-panel";
	panel.setAttribute("role", "region");
	panel.setAttribute("aria-label", label);
	// The panel scrolls internally, so it must be reachable and scrollable by keyboard in
	// every engine, not only where scrollable regions are focusable by default.
	panel.tabIndex = 0;
	const status = document.createElement("p");
	status.className = "subagent-inspect-status";
	status.setAttribute("role", "status");
	const body = document.createElement("div");
	body.className = "subagent-inspect-body";
	panel.append(status, body);
	const nodes = { key, childId, container, toggle, panel, status, body };
	toggle.addEventListener("click", () => toggleInspect(nodes));
	state.subagentInspectNodes.set(key, nodes);
	container.append(toggle, panel);
	paintInspect(nodes);
	return container;
}

/** Bounded child list: id-bearing nodes get their own view, others say why they cannot. */
function renderChildNode(runId, child, depth = 0) {
	const item = document.createElement("li");
	item.className = "subagent-child";
	appendSubagentText(item, "subagent-child-summary", summaryText(child));
	const childId = typeof child?.id === "string" && child.id.length > 0 ? child.id : null;
	if (childId) {
		item.append(buildInspectPanel({ runId, childId, label: `Read-only inspector for child node ${childId}` }));
	} else {
		appendSubagentText(
			item,
			"subagent-inspect-unavailable",
			"Read-only inspector unavailable: this node has no id in the status snapshot, and the host only accepts node ids it has reported.",
		);
	}
	const nested = Array.isArray(child?.children) ? child.children : [];
	if (nested.length > 0 && depth < 4) {
		const list = document.createElement("ul");
		list.className = "subagent-child-list";
		for (const node of nested) {
			list.append(renderChildNode(runId, node, depth + 1));
		}
		item.append(list);
	}
	return item;
}

function renderChildrenList(card, run) {
	const children = Array.isArray(run.children) ? run.children : [];
	if (children.length === 0) {
		return;
	}
	const details = document.createElement("details");
	details.className = "subagent-children";
	// Each poll rebuilds the page; keep the disclosure the reader opened open.
	details.open = state.subagentOpenChildren.get(run.id) === true;
	details.addEventListener("toggle", () => {
		state.subagentOpenChildren.set(run.id, details.open === true);
	});
	const summary = document.createElement("summary");
	summary.textContent = `Child summaries (${children.length})`;
	const list = document.createElement("ul");
	for (const child of children) {
		list.append(renderChildNode(run.id, child));
	}
	details.append(summary, list);
	card.append(details);
}

function renderAsyncRun(run) {
	const card = document.createElement("article");
	card.className = "subagent-run";
	const title = document.createElement("h4");
	title.className = "subagent-run-title";
	title.textContent = run.label ? `${run.label} (${subagentValue(run.id)})` : `Async run ${subagentValue(run.id)}`;
	card.append(title);
	// Only the fields this run actually reports: a running run has no `ended`, and an omitted
	// model is not "Unknown", it is simply not part of the answer.
	const meta = [];
	if (typeof run.state === "string" && run.state.length > 0) meta.push(`state: ${run.state}`);
	if (typeof run.mode === "string" && run.mode.length > 0) meta.push(`mode: ${run.mode}`);
	if (typeof run.model === "string" && run.model.length > 0) meta.push(`model: ${run.model}`);
	if (typeof run.startedAt === "number") meta.push(`started: ${subagentTime(run.startedAt)}`);
	if (typeof run.updatedAt === "number") meta.push(`last update: ${subagentTime(run.updatedAt)}`);
	if (typeof run.endedAt === "number") meta.push(`ended: ${subagentTime(run.endedAt)}`);
	if (meta.length > 0) appendSubagentText(card, "subagent-run-meta", meta.join(" · "));
	if (run.goal) appendSubagentText(card, "subagent-run-goal", `goal: ${run.goal}`);
	const actions = document.createElement("div");
	actions.className = "subagent-run-actions";
	const button = document.createElement("button");
	button.type = "button";
	// Both run actions are read-only and secondary: they share one compact pill size so a
	// page full of runs does not become a wall of buttons.
	button.className = "ghost small";
	button.textContent = "View transcript";
	const result = document.createElement("p");
	result.className = "subagent-run-meta";
	result.dataset.state = "";
	button.addEventListener("click", () => requestSubagentDetail(card, run.id, button, result));
	actions.append(button, result);
	card.append(actions);
	// The two views are not alternatives: the inspector renders whatever shape pi-subagents
	// serves for this run (structured child session for async, transcript for a blocking run),
	// while the artifact tail below stays the page's own raw fallback. That explanation lives
	// once on the page: repeating it inside every run is what used to fill the rail.
	card.append(buildInspectPanel({ runId: run.id, label: `Read-only inspector for async run ${run.id}` }));
	renderChildrenList(card, run);
	renderSummaryList(card, "Result summaries", run.results, "subagent-results");
	return card;
}

/** Compact counts for the page heading: one tag, and only when a snapshot state carries counts. */
function subagentsTagText(snapshot) {
	if (!snapshot || typeof snapshot !== "object") return "";
	if (snapshot.state === "ready-data") {
		const fleetCount = Array.isArray(snapshot.fleet?.entries) ? snapshot.fleet.entries.length : 0;
		const asyncCount = Array.isArray(snapshot.asyncSnapshot?.runs) ? snapshot.asyncSnapshot.runs.length : 0;
		return `${fleetCount} fleet · ${asyncCount} async`;
	}
	if (snapshot.state === "ready-empty") return "none active";
	// loading/error/unavailable carry no counts: the state label beside the tag says why.
	return "";
}

function subagentsStatusText(snapshot) {
	if (!snapshot || typeof snapshot !== "object") return ["Unavailable", "unavailable", "Subagent status is not attached to the current Pi session."];
	if (snapshot.state === "loading") return ["Loading", "loading", "Loading read-only pi-subagents status…"];
	if (snapshot.state === "ready-empty") {
		const fleetOmitted = snapshot.fleet?.omitted ?? 0;
		const asyncOmitted = snapshot.asyncSnapshot?.omitted?.runs ?? 0;
		const omitted = fleetOmitted + asyncOmitted;
		if (omitted > 0) return ["Ready · empty", "ready", `No visible entries; ${omitted} entry/run item(s) were omitted or truncated.`];
		// A finished blocking delegation leaves the active fleet, but its chat row keeps the run
		// inspectable: "nothing is active" must not read as "nothing is readable".
		const referenced = Number.isSafeInteger(snapshot.referencedRuns) && snapshot.referencedRuns > 0 ? snapshot.referencedRuns : 0;
		if (referenced > 0) {
			return [
				"Ready · empty",
				"ready",
				`No active fleet entries or async runs. ${referenced} chat-attributed run${referenced === 1 ? "" : "s"} remain${referenced === 1 ? "s" : ""} inspectable from ${referenced === 1 ? "its" : "their"} chat row.`,
			];
		}
		return ["Ready · empty", "ready", "No fleet entries or async runs are active."];
	}
	if (snapshot.state === "ready-data") {
		const fleetCount = Array.isArray(snapshot.fleet?.entries) ? snapshot.fleet.entries.length : 0;
		const asyncCount = Array.isArray(snapshot.asyncSnapshot?.runs) ? snapshot.asyncSnapshot.runs.length : 0;
		const fleetOmitted = snapshot.fleet?.omitted ?? 0;
		const asyncOmitted = snapshot.asyncSnapshot?.omitted?.runs ?? 0;
		const parts = [`${fleetCount} fleet entr${fleetCount === 1 ? "y" : "ies"}`, `${asyncCount} async run${asyncCount === 1 ? "" : "s"}`];
		if (fleetOmitted > 0) parts.push(`${fleetOmitted} fleet item(s) omitted/truncated`);
		if (asyncOmitted > 0 || snapshot.asyncSnapshot?.omitted?.children > 0 || snapshot.asyncSnapshot?.omitted?.byteLimitExceeded === true) parts.push("async data omitted/truncated");
		return ["Ready", "ready", parts.join(" · ")];
	}
	const error = snapshot.error && typeof snapshot.error === "object" ? snapshot.error : {};
	const code = typeof error.code === "string" ? error.code : "rpc_unavailable";
	const message = typeof error.message === "string" ? error.message : "pi-subagents status is unavailable";
	if (code === "timeout") return ["Unavailable · timeout", "unavailable", `pi-subagents RPC timed out: ${message}`];
	if (snapshot.state === "error") return ["Error", "error", `pi-subagents RPC failed (${code}): ${message}`];
	return ["Unavailable", "unavailable", code === "rpc_unavailable" ? "pi-subagents in-process RPC is unavailable." : `pi-subagents status unavailable (${code}): ${message}`];
}

/** Render the bounded fleet and async-run DTO projection into the subagents page; refresh is
 *  explicit only, and nothing here needs the page to be the one on screen. */
function renderSubagents(snapshot) {
	state.subagentsSnapshot = snapshot && typeof snapshot === "object" ? snapshot : null;
	state.subagentsGeneration = state.generation;
	const [label, stateName, message] = subagentsStatusText(state.subagentsSnapshot);
	elements.subagentsState.textContent = label;
	elements.subagentsState.dataset.state = stateName;
	elements.subagentsTag.textContent = subagentsTagText(state.subagentsSnapshot);
	elements.subagentsStatus.textContent = message;
	elements.subagentsStatus.dataset.state = stateName === "error" ? "error" : stateName === "ready" ? "ok" : "";
	elements.subagentsRefresh.disabled = state.generation === null || state.reloading || state.subagentsRefreshing;
	clearElement(elements.subagentsFleet);
	clearElement(elements.subagentsAsync);
	const fleetEntries = Array.isArray(state.subagentsSnapshot?.fleet?.entries) ? state.subagentsSnapshot.fleet.entries : [];
	const asyncRuns = Array.isArray(state.subagentsSnapshot?.asyncSnapshot?.runs) ? state.subagentsSnapshot.asyncSnapshot.runs : [];
	// The page is rebuilt on every snapshot revision: drop the DOM registry of the previous
	// pass and every cached structured view whose run is gone, so neither can grow unbounded.
	// Only the page's own `run:` key space is touched: a chat row owns a `chat:` panel whose
	// node is *not* rebuilt by this pass, and whose run may legitimately have left the bounded
	// snapshot, so clearing or pruning it here would strand it on its previous paint.
	for (const key of [...state.subagentInspectNodes.keys()]) {
		if (key.startsWith(PAGE_INSPECT_KEY_PREFIX)) state.subagentInspectNodes.delete(key);
	}
	const activeRunIds = new Set();
	for (const run of asyncRuns) {
		if (run && typeof run.id === "string") activeRunIds.add(run.id);
	}
	for (const [key, entry] of [...state.subagentInspects]) {
		if (key.startsWith(PAGE_INSPECT_KEY_PREFIX) && !activeRunIds.has(entry.runId)) state.subagentInspects.delete(key);
	}
	for (const runId of [...state.subagentOpenChildren.keys()]) {
		if (!activeRunIds.has(runId)) state.subagentOpenChildren.delete(runId);
	}
	for (const entry of fleetEntries) elements.subagentsFleet.append(renderFleetEntry(entry));
	for (const run of asyncRuns) {
		if (run && typeof run.id === "string") elements.subagentsAsync.append(renderAsyncRun(run));
	}
	elements.subagentsFleetEmpty.classList.toggle("hidden", fleetEntries.length > 0);
	elements.subagentsAsyncEmpty.classList.toggle("hidden", asyncRuns.length > 0);
}

async function refreshSubagents() {
	if (state.generation === null || state.subagentsRefreshing) return;
	state.subagentsRefreshing = true;
	elements.subagentsRefresh.disabled = true;
	elements.subagentsStatus.textContent = "Refreshing read-only pi-subagents status…";
	elements.subagentsStatus.dataset.state = "";
	try {
		const response = await api("/api/subagents/refresh", {
			method: "POST",
			body: { generation: state.generation },
		});
		const payload = await response.json().catch(() => ({}));
		if (payload?.subagents) renderSubagents(payload.subagents);
		if (!response.ok) {
			const code = payload?.error?.code ?? `http_${response.status}`;
			elements.subagentsStatus.textContent = `Refresh failed (${code}): ${payload?.error?.message ?? "unknown reason"}`;
			elements.subagentsStatus.dataset.state = "error";
			if (response.status === 401) handleUnauthorized();
		}
	} catch (error) {
		elements.subagentsStatus.textContent = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
		elements.subagentsStatus.dataset.state = "error";
	} finally {
		state.subagentsRefreshing = false;
		elements.subagentsRefresh.disabled = state.generation === null || state.reloading;
	}
}

const FALLBACK_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function modelLabel(model) {
	if (!model || typeof model !== "object") {
		return "unavailable";
	}
	const identity = [model.provider, model.id].filter((value) => typeof value === "string" && value.length > 0).join("/");
	const name = typeof model.name === "string" && model.name.length > 0 ? ` · ${model.name}` : "";
	return identity ? `${identity}${name}` : "unavailable";
}

/**
 * Value a rebuilt select should show: the pick the user just made while it is still
 * offered (its change request may still be in flight), otherwise the host's current
 * value, otherwise nothing.
 */
function keepSelectedValue(optionValues, selected, fallback) {
	if (selected && optionValues.includes(selected)) {
		return selected;
	}
	return fallback && optionValues.includes(fallback) ? fallback : "";
}

/** `provider/id` identity of the host's current model, or "" when it is unknown. */
function currentModelKey(controls) {
	const model = controls?.model;
	if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
		return "";
	}
	return `${model.provider}/${model.id}`;
}

function renderControls(controls) {
	// `renderControls` runs on every poll (~600 ms) and rebuilds both selects, which
	// clears `select.value`. Read the open selections first so the pick whose change
	// request is still in flight survives the rebuild instead of snapping back to the
	// current model/level before the request lands.
	const selectedModelKey = elements.modelSelect.value;
	const selectedThinkingLevel = elements.thinkingSelect.value;

	if (!controls || controls.available !== true) {
		elements.controlsState.textContent = "Unavailable";
		elements.modelCurrent.textContent = "Current model: unavailable";
		elements.modelSelect.textContent = "";
		elements.thinkingSelect.textContent = "";
		elements.modelSelect.disabled = true;
		elements.thinkingSelect.disabled = true;
		state.controls = null;
		return;
	}

	const candidates = Array.isArray(controls.candidates) ? controls.candidates : [];
	const currentKey = currentModelKey(controls);
	elements.controlsState.textContent = state.reloading ? "Reloading…" : "Connected";
	elements.modelCurrent.textContent = `Current model: ${modelLabel(controls.model)}`;
	elements.modelSelect.textContent = "";
	const candidateKeys = [];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate.key !== "string") {
			continue;
		}
		candidateKeys.push(candidate.key);
		const option = document.createElement("option");
		option.value = candidate.key;
		const thinking = typeof candidate.thinkingLevel === "string" ? ` · thinking ${candidate.thinkingLevel}` : "";
		option.textContent = `${modelLabel(candidate)}${thinking}`;
		elements.modelSelect.append(option);
	}
	elements.modelSelect.value = keepSelectedValue(candidateKeys, selectedModelKey, currentKey);

	const levels = Array.isArray(controls.thinkingLevels) && controls.thinkingLevels.length > 0
		? controls.thinkingLevels.filter((level) => FALLBACK_THINKING_LEVELS.includes(level))
		: FALLBACK_THINKING_LEVELS;
	elements.thinkingSelect.textContent = "";
	for (const level of levels) {
		const option = document.createElement("option");
		option.value = level;
		option.textContent = level;
		elements.thinkingSelect.append(option);
	}
	elements.thinkingSelect.value = keepSelectedValue(levels, selectedThinkingLevel, controls.thinkingLevel);

	const disabled = state.reloading;
	elements.modelSelect.disabled = disabled || candidates.length === 0 || state.modelSending;
	elements.thinkingSelect.disabled = disabled || levels.length === 0 || state.thinkingSending;
	state.controls = controls;
}

async function submitControl(path, body, kind) {
	if (state.generation === null) {
		setControlStatus(elements[`${kind}Status`], "The Pi session is not connected.", "error");
		return;
	}
	const statusElement = elements[`${kind}Status`];
	const sendingKey = `${kind}Sending`;
	if (state[sendingKey]) {
		return;
	}
	state[sendingKey] = true;
	setControlStatus(statusElement, `${kind === "model" ? "Applying model" : "Applying thinking level"}…`, "waiting");
	renderControls(state.controls);
	try {
		const response = await api(path, {
			method: "POST",
			body: { generation: state.generation, ...body },
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const code = payload?.error?.code ?? `http_${response.status}`;
			setControlStatus(statusElement, `${kind === "model" ? "Model" : "Thinking level"} change rejected (${code}): ${payload?.error?.message ?? "unknown reason"}`, "error");
			if (response.status === 401) {
				handleUnauthorized();
			}
			return;
		}
		const controls = payload?.controls;
		const effective = kind === "model" ? modelLabel(payload?.effectiveModel ?? controls?.model) : payload?.effectiveLevel ?? controls?.thinkingLevel;
		const clamped = kind === "thinking" && payload?.clamped === true;
		setControlStatus(
			statusElement,
			kind === "model"
				? `Model request accepted; effective model is ${effective}. The current turn state is unchanged.`
				: `Thinking request accepted; effective level is ${effective ?? "unavailable"}${clamped ? " (host clamped the request)" : ""}. The current turn state is unchanged.`,
			"ok",
		);
		await poll();
	} catch (error) {
		setControlStatus(statusElement, `${kind === "model" ? "Model" : "Thinking level"} change failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		state[sendingKey] = false;
		renderControls(state.controls);
	}
}

async function submitModel() {
	const key = elements.modelSelect.value;
	if (!key) {
		setControlStatus(elements.modelStatus, "Choose an available model candidate first.", "error");
		return;
	}
	if (key === currentModelKey(state.controls)) {
		// The select already shows the model the host reports as current: re-picking it
		// is not a change and must not add another request (or another status line).
		return;
	}
	await submitControl("/api/model", { key }, "model");
}

async function submitThinking() {
	const level = elements.thinkingSelect.value;
	if (!FALLBACK_THINKING_LEVELS.includes(level)) {
		setControlStatus(elements.thinkingStatus, "Choose an allowed thinking level first.", "error");
		return;
	}
	if (state.controls?.thinkingLevel === level) {
		return;
	}
	await submitControl("/api/thinking", { level }, "thinking");
}

function chatMessageLabel(message) {
	if (message.kind === "tool_execution") {
		return message.toolName || "tool";
	}
	return message.role === "toolResult" ? message.toolName || "tool" : message.role || "message";
}

function blockKey(block, index) {
	const identity = block?.toolCallId || block?.id || block?.name || index;
	return `${block?.type || "unknown"}:${identity}:${index}`;
}

function toolResultText(block) {
	const content = typeof block?.content === "string" ? block.content : "";
	const error = typeof block?.error === "string" && block.error.length > 0 ? block.error : "";
	if (!error || error === content) {
		return content || (error ? `Error: ${error}` : "");
	}
	return `Error: ${error}${content ? `\n${content}` : ""}`;
}

let markdownIsland = null;
let markdownIslandPromise = null;

function loadMarkdownIsland() {
	if (markdownIslandPromise) {
		return markdownIslandPromise;
	}
	markdownIslandPromise = import("./markdown-island.jsx")
		.then((mod) => {
			markdownIsland = mod;
			return mod;
		})
		.catch(() => {
			markdownIsland = false;
			return null;
		});
	return markdownIslandPromise;
}

loadMarkdownIsland();

function messageIsStreaming(message) {
	return state.chat?.phase === "streaming"
		&& Boolean(message?.id)
		&& state.chatOrder[state.chatOrder.length - 1] === message.id
		&& message.role !== "user";
}

function shouldMarkdown(message) {
	return message?.role === "assistant" || message?.role === "system" || !message?.role;
}

function unmountMarkdownHosts(root) {
	if (!root) {
		return;
	}
	const hosts = [];
	if (root.classList?.contains("chat-markdown")) {
		hosts.push(root);
	}
	if (typeof root.querySelectorAll === "function") {
		hosts.push(...root.querySelectorAll(".chat-markdown"));
	}
	const api = markdownIsland && markdownIsland !== false ? markdownIsland : null;
	for (const host of hosts) {
		api?.unmountMarkdown(host);
	}
}

function paintMarkdownHost(host, text, streaming) {
	host.dataset.markdownText = text;
	host.dataset.streaming = streaming ? "1" : "0";
	if (markdownIsland && markdownIsland !== false) {
		markdownIsland.mountMarkdown(host, { text, streaming });
		return;
	}
	host.textContent = text;
	if (markdownIsland === false) {
		return;
	}
	loadMarkdownIsland().then((mod) => {
		if (!mod || !host.isConnected) {
			return;
		}
		const next = host.dataset.markdownText ?? "";
		const nextStreaming = host.dataset.streaming === "1";
		host.textContent = "";
		mod.mountMarkdown(host, { text: next, streaming: nextStreaming });
	});
}

function blockDetails(block, key, open) {
	const details = document.createElement("details");
	const classType = block.type === "toolCall" ? "tool-call" : block.type === "toolResult" ? "tool-result" : block.type || "unknown";
	details.className = `chat-block chat-${classType}`;
	details.dataset.blockKey = key;
	details.open = open;
	const summary = document.createElement("summary");
	const name = block.name || "tool";
	if (block.type === "thinking") {
		summary.textContent = "Thinking";
	} else if (block.type === "toolCall") {
		summary.textContent = `Tool call: ${name}`;
	} else {
		summary.textContent = `Tool result: ${name}${block.isError ? " (error)" : ""}`;
	}
	const content = document.createElement("pre");
	content.className = "chat-block-content";
	if (block.type === "thinking") {
		content.textContent = typeof block.text === "string" ? block.text : "";
	} else if (block.type === "toolCall") {
		content.textContent = typeof block.arguments === "string" && block.arguments.length > 0 ? block.arguments : "(no arguments)";
	} else {
		content.textContent = toolResultText(block);
	}
	details.append(summary, content);
	return details;
}

function renderChatBlocks(card, message) {
	let container = card.querySelector(".chat-blocks");
	if (!container) {
		container = document.createElement("div");
		container.className = "chat-blocks";
		card.append(container);
	}
	const previousOpen = new Map();
	for (const details of container.querySelectorAll("details")) {
		previousOpen.set(details.dataset.blockKey, details.open === true);
	}
	const textHosts = new Map();
	let inspectPanel = null;
	for (const child of [...container.children]) {
		if (child.classList?.contains("subagent-inspect")) {
			inspectPanel = child;
			continue;
		}
		if (child.classList?.contains("chat-text") && child.dataset.blockKey) {
			textHosts.set(child.dataset.blockKey, child);
		}
	}

	const nextChildren = [];
	const usedKeys = new Set();
	const streaming = messageIsStreaming(message);
	const markdown = shouldMarkdown(message);

	const takeTextHost = (key, text) => {
		let host = textHosts.get(key);
		if (!host) {
			host = document.createElement("div");
			host.className = "chat-text";
			host.dataset.blockKey = key;
		}
		if (markdown) {
			host.classList.add("chat-markdown");
			paintMarkdownHost(host, text, streaming);
		} else {
			host.classList.remove("chat-markdown");
			host.textContent = text;
		}
		usedKeys.add(key);
		nextChildren.push(host);
	};

	const blocks = Array.isArray(message.blocks) ? message.blocks : [];
	let rendered = 0;
	let hasVisibleText = false;
	let hasToolResult = false;
	blocks.forEach((block, index) => {
		if (!block || typeof block !== "object") {
			return;
		}
		if (block.type === "text") {
			takeTextHost(blockKey(block, index), typeof block.text === "string" ? block.text : "");
			rendered += 1;
			hasVisibleText = true;
			return;
		}
		if (block.type !== "thinking" && block.type !== "toolCall" && block.type !== "toolResult") {
			return;
		}
		if (block.type === "toolResult") {
			hasToolResult = true;
		}
		const key = blockKey(block, index);
		const longOutput = block.type === "toolResult" && toolResultText(block).length > 1200;
		const defaultOpen = block.type === "toolResult" ? !longOutput : false;
		nextChildren.push(blockDetails(block, key, previousOpen.has(key) ? previousOpen.get(key) : defaultOpen));
		usedKeys.add(key);
		rendered += 1;
	});

	if (rendered === 0 || (typeof message.text === "string" && message.text.length > 0 && !hasVisibleText && !hasToolResult)) {
		takeTextHost("text:fallback:0", typeof message.text === "string" ? message.text : "");
	}

	for (const [key, host] of textHosts) {
		if (!usedKeys.has(key)) {
			unmountMarkdownHosts(host);
		}
	}

	// A pi-subagents tool result names the async run it launched, so the chat row can open the
	// same structured view the subagents page offers. The chat scope keeps its own panel state:
	// the page panel for the same run must not be repainted by this one.
	const runId = typeof message.subagentRunId === "string" ? message.subagentRunId : null;
	if (runId) {
		if (!inspectPanel || inspectPanel.dataset.runId !== runId) {
			inspectPanel?.remove();
			inspectPanel = buildInspectPanel({
				runId,
				label: `Read-only inspector for subagent run ${runId}`,
				keyPrefix: CHAT_INSPECT_KEY_PREFIX.slice(0, -1),
			});
			inspectPanel.classList.add("subagent-inspect-chat");
		}
		nextChildren.push(inspectPanel);
	} else {
		inspectPanel?.remove();
	}

	container.replaceChildren(...nextChildren);
}

function chatCardFor(message) {
	const card = document.createElement("article");
	card.className = "chat-message";
	card.dataset.id = message.id;
	card.dataset.role = message.role || "system";
	const label = document.createElement("p");
	label.className = "chat-message-label";
	label.textContent = chatMessageLabel(message);
	card.append(label);
	renderChatBlocks(card, message);
	return card;
}

function updateChatCard(card, message) {
	card.dataset.role = message.role || "system";
	const label = card.querySelector(".chat-message-label");
	if (label) {
		label.textContent = chatMessageLabel(message);
	}
	renderChatBlocks(card, message);
}

function validChatRevision(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

function clearChatCards() {
	for (const [, card] of state.chatRendered) {
		unmountMarkdownHosts(card);
		card.remove();
	}
	state.chatRendered.clear();
	state.chatRenderedRevisions.clear();
}

function resetChatState() {
	clearChatCards();
	state.chatRevision = null;
	state.chatMessages.clear();
	state.chatOrder = [];
	state.chat = null;
	state.chatLastError = null;
}

function applyChatSnapshot(chat) {
	const messages = Array.isArray(chat.messages) ? chat.messages : [];
	const hasMessagesFull = Object.prototype.hasOwnProperty.call(chat, "messagesFull");
	const messagesFull = chat.messagesFull === true || !hasMessagesFull;
	if (messagesFull) {
		state.chatMessages.clear();
		for (const message of messages) {
			if (message && typeof message.id === "string") {
				state.chatMessages.set(message.id, message);
			}
		}
		const listedIds = Array.isArray(chat.historyIds) ? chat.historyIds : messages.map((message) => message?.id);
		const nextOrder = [];
		const seenIds = new Set();
		for (const id of listedIds) {
			if (typeof id === "string" && state.chatMessages.has(id) && !seenIds.has(id)) {
				seenIds.add(id);
				nextOrder.push(id);
			}
		}
		for (const id of state.chatMessages.keys()) {
			if (!seenIds.has(id)) {
				seenIds.add(id);
				nextOrder.push(id);
			}
		}
		state.chatOrder = nextOrder;
	} else {
		for (const message of messages) {
			if (!message || typeof message.id !== "string") {
				continue;
			}
			const isNew = !state.chatMessages.has(message.id);
			state.chatMessages.set(message.id, message);
			if (isNew && chat.historyIds === null) {
				state.chatOrder.push(message.id);
			}
		}
		if (Array.isArray(chat.historyIds)) {
			const listedIds = new Set(chat.historyIds.filter((id) => typeof id === "string"));
			for (const id of state.chatMessages.keys()) {
				if (!listedIds.has(id)) {
					state.chatMessages.delete(id);
				}
			}
			const nextOrder = [];
			const seenIds = new Set();
			for (const id of chat.historyIds) {
				if (typeof id === "string" && state.chatMessages.has(id) && !seenIds.has(id)) {
					seenIds.add(id);
					nextOrder.push(id);
				}
			}
			state.chatOrder = nextOrder;
		}
	}
	if (validChatRevision(chat.revision)) {
		state.chatRevision = chat.revision;
	}
}

function reorderChatCards(cards) {
	for (let index = 0; index < cards.length; index += 1) {
		const card = cards[index];
		if (elements.chatHistory.children[index] === card) {
			continue;
		}
		const before = elements.chatHistory.children[index] ?? null;
		if (typeof elements.chatHistory.insertBefore === "function") {
			elements.chatHistory.insertBefore(card, before);
		} else {
			card.remove();
			elements.chatHistory.append(card);
		}
	}
}

function renderChat(chat) {
	if (!chat || chat.available !== true) {
		resetChatState();
		elements.chatPhase.textContent = "Unavailable";
		elements.chatEmpty.textContent = "Chat is not attached to the current Pi session.";
		elements.chatEmpty.classList.remove("hidden");
		elements.chatSend.disabled = true;
		elements.chatStop.disabled = true;
		elements.chatDelivery.disabled = true;
		setChatStatus("", "");
		return;
	}
	const previousLastError = state.chatLastError;
	const nextLastError = typeof chat.lastError === "string" && chat.lastError.length > 0 ? chat.lastError : null;
	if (nextLastError !== previousLastError) {
		state.chatLastError = nextLastError;
		if (nextLastError) {
			setChatStatus(nextLastError, "error");
		} else if (elements.chatStatus.dataset.state === "error" && elements.chatStatus.textContent === previousLastError) {
			// A successful send may have replaced the error with an acceptance message
			// before this poll observes lastError clearing. Do not erase that newer text.
			setChatStatus("", "");
		}
	}
	applyChatSnapshot(chat);
	// MarkdownText keeps TeX literal while streaming. The island must see the
	// current phase (not the previous poll) and must re-render on idle even when
	// the message revision did not change, otherwise formulas stay as `$…$`.
	state.chat = chat;
	const phase = chat.phase || "unknown";
	const delivery = elements.chatDelivery.value || "normal";
	const deliveryCanSend = phase === "idle" || (phase === "streaming" && delivery !== "normal");
	elements.chatPhase.textContent = phase === "streaming" ? "Streaming" : phase === "idle" ? "Idle" : "Unknown";
	elements.chatSend.disabled = !deliveryCanSend || state.reloading || state.chatSending;
	elements.chatStop.disabled = phase !== "streaming" || state.reloading;
	elements.chatDelivery.disabled = state.reloading || state.chatSending;
	const cards = [];
	const seen = new Set();
	for (const id of state.chatOrder) {
		const message = state.chatMessages.get(id);
		if (!message || typeof message.id !== "string") {
			continue;
		}
		seen.add(message.id);
		const existing = state.chatRendered.get(message.id);
		const revision = validChatRevision(message.revision) ? message.revision : null;
		const streaming = messageIsStreaming(message);
		if (existing) {
			const wasStreaming = existing.dataset.markdownStreaming === "1";
			if (revision === null || state.chatRenderedRevisions.get(message.id) !== revision || streaming !== wasStreaming) {
				updateChatCard(existing, message);
				existing.dataset.markdownStreaming = streaming ? "1" : "0";
				if (revision === null) {
					state.chatRenderedRevisions.delete(message.id);
					delete existing.dataset.revision;
				} else {
					state.chatRenderedRevisions.set(message.id, revision);
					existing.dataset.revision = String(revision);
				}
			}
			cards.push(existing);
			continue;
		}
		const card = chatCardFor(message);
		card.dataset.markdownStreaming = streaming ? "1" : "0";
		if (revision !== null) {
			state.chatRenderedRevisions.set(message.id, revision);
			card.dataset.revision = String(revision);
		}
		state.chatRendered.set(message.id, card);
		elements.chatHistory.append(card);
		cards.push(card);
	}
	for (const [id, card] of [...state.chatRendered.entries()]) {
		if (!seen.has(id)) {
			unmountMarkdownHosts(card);
			card.remove();
			state.chatRendered.delete(id);
			state.chatRenderedRevisions.delete(id);
		}
	}
	reorderChatCards(cards);
	elements.chatEmpty.classList.toggle("hidden", state.chatRendered.size > 0);
	// Always restore the ordinary empty-state wording: the detached wording is set by
	// renderChat() when chat is unavailable, and this element stays hidden while rows exist.
	elements.chatEmpty.textContent = "No chat messages yet.";
}

function deliveryLabel(delivery) {
	switch (delivery) {
		case "followUp":
			return "Follow-up";
		case "steer":
			return "Steer";
		default:
			return "Normal";
	}
}

async function sendChatMessage() {
	const text = elements.chatInput.value;
	if (typeof text !== "string" || text.trim().length === 0) {
		setChatStatus("Enter a message first.", "error");
		return;
	}
	if (state.generation === null) {
		setChatStatus("The Pi session is not connected.", "error");
		return;
	}
	const delivery = elements.chatDelivery.value || "normal";
	if (!["normal", "steer", "followUp"].includes(delivery)) {
		setChatStatus(`Delivery rejected: ${delivery || "unknown"} is not supported.`, "error");
		return;
	}
	const phase = state.chat?.phase;
	if (phase === "streaming" && delivery === "normal") {
		setChatStatus("The Pi agent is busy; normal delivery is idle-only. Choose Steer or Follow-up while it is streaming.", "error");
		return;
	}
	if (phase !== "idle" && phase !== "streaming") {
		setChatStatus("The current Pi chat state is unavailable; wait for it to reconnect.", "error");
		return;
	}
	if (state.chatSending) {
		return;
	}
	state.chatSending = true;
	elements.chatSend.disabled = true;
	setChatStatus(`Submitting ${deliveryLabel(delivery)} delivery to the current Pi session…`, "");
	try {
		const body = { generation: state.generation, text };
		// Keep the 3.1a normal request shape; explicit queued modes carry the
		// bridge-level marker and are translated to Pi's deliverAs option server-side.
		if (delivery !== "normal") {
			body.delivery = delivery;
		}
		const response = await api("/api/message", {
			method: "POST",
			body,
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const code = payload?.error?.code ?? `http_${response.status}`;
			setChatStatus(`Message rejected (${code}): ${payload?.error?.message ?? "unknown reason"}`, "error");
			if (response.status === 401) {
				handleUnauthorized();
			}
			return;
		}
		elements.chatInput.value = "";
		const actualDelivery = payload?.delivery ?? delivery;
		const requestedDelivery = payload?.requestedDelivery ?? delivery;
		if (payload?.execution === "immediate") {
			setChatStatus(
				payload?.message || "Extension slash command executed immediately; it was not queued.",
				"ok",
			);
		} else if (payload?.queued === true) {
			setChatStatus(
				`${deliveryLabel(actualDelivery)} request accepted and queued; it has not executed yet.`,
				"ok",
			);
		} else if (actualDelivery !== requestedDelivery || payload?.normalized === true) {
			setChatStatus(
				`${deliveryLabel(requestedDelivery)} selection accepted as an immediate normal message; execution has not completed.`,
				"ok",
			);
		} else {
			setChatStatus(
				`${deliveryLabel(actualDelivery)} message accepted; execution has not completed. The response will appear below as it streams.`,
				"ok",
			);
		}
		await poll();
	} catch (error) {
		setChatStatus(`Message failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		state.chatSending = false;
		if (state.chat) {
			renderChat(state.chat);
		}
	}
}

async function stopChat() {
	if (state.generation === null) {
		setChatStatus("The Pi session is not connected.", "error");
		return;
	}
	try {
		const response = await api("/api/stop", {
			method: "POST",
			body: { generation: state.generation },
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const code = payload?.error?.code ?? `http_${response.status}`;
			setChatStatus(`Stop rejected (${code}): ${payload?.error?.message ?? "unknown reason"}`, "error");
			if (response.status === 401) {
				handleUnauthorized();
			}
			return;
		}
		setChatStatus("Stop requested from the current Pi context.", "ok");
		await poll();
	} catch (error) {
		setChatStatus(`Stop failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function render(snapshot) {
	const pending = Array.isArray(snapshot.pending) ? snapshot.pending : [];
	const seen = new Set();
	for (const request of pending) {
		seen.add(request.id);
		const existing = state.rendered.get(request.id);
		if (existing) {
			updateMeta(existing, request);
			continue;
		}
		const card = cardFor(request);
		state.rendered.set(request.id, card);
		elements.requests.append(card);
	}
	for (const [id, card] of [...state.rendered.entries()]) {
		if (!seen.has(id)) {
			card.remove();
			state.rendered.delete(id);
		}
	}
	elements.empty.classList.toggle("hidden", state.rendered.size > 0);
	renderStatus(snapshot.status);
	renderControls(snapshot.controls);
	const nextSubagentsState = snapshot.subagents?.state ?? "unavailable";
	const nextSubagentsRevision = snapshot.subagents?.revision;
	const subagentsRevisionChanged = nextSubagentsRevision !== undefined
		&& nextSubagentsRevision !== state.subagentsSnapshot?.revision;
	if (
		state.subagentsSnapshot === null
		|| state.subagentsGeneration !== state.generation
		|| state.subagentsSnapshot.state !== nextSubagentsState
		|| subagentsRevisionChanged
	) {
		renderSubagents(snapshot.subagents);
	}
}

function handleUnauthorized() {
	state.stopped = true;
	resetChatState();
	setConnection("Not authorized for this Pi process.", "unauthorized");
	showAuth(
		"Pi is not accepting this page token any more (for example after the Pi process was restarted). " +
			"Open the browser URL of the running Pi session to continue, or paste its token below.",
	);
}

function setReloadState(text, stateName) {
	elements.reloadState.textContent = text;
	elements.reloadState.dataset.state = stateName ?? "";
}

async function requestReload() {
	if (state.reloading) {
		return;
	}
	state.reloading = true;
	resetChatState();
	elements.reloadButton.disabled = true;
	setReloadState("Reloading the Pi session…", "waiting");
	try {
		const response = await api("/api/reload", { method: "POST", body: {} });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			state.reloading = false;
			elements.reloadButton.disabled = false;
			if (response.status === 401) {
				handleUnauthorized();
				return;
			}
			const code = payload?.error?.code ?? `http_${response.status}`;
			setReloadState(`Reload refused (${code}): ${payload?.error?.message ?? "unknown reason"}`, "error");
			return;
		}
		setReloadState(`Reload accepted (generation ${payload.generation}). Waiting for the new binding…`, "waiting");
	} catch (error) {
		state.reloading = false;
		elements.reloadButton.disabled = false;
		setReloadState(`Reload failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function statePath() {
	return validChatRevision(state.chatRevision) ? `/api/state?since=${state.chatRevision}` : "/api/state";
}

async function poll() {
	if (state.stopped) {
		return;
	}
	try {
		const response = await api(statePath());
		if (response.status === 401) {
			handleUnauthorized();
			return;
		}
		if (!response.ok) {
			setConnection(`Host replied HTTP ${response.status}`, "notice");
			return;
		}
		let snapshot = await response.json();
		state.pollInterval = POLL_INTERVAL_MS;
		hideAuth();

		const generationChanged = state.generation !== null && snapshot.generation !== state.generation;
		if (generationChanged) {
			// A new binding generation owns the session: drop stale local cards and chat rows.
			for (const [, card] of state.rendered) {
				card.remove();
			}
			state.rendered.clear();
			resetChatState();
			state.subagentDetails.clear();
			state.subagentInspects.clear();
			state.subagentInspectNodes.clear();
			state.subagentOpenChildren.clear();
			state.subagentsSnapshot = null;
			state.subagentsGeneration = null;
		}
		if (generationChanged && snapshot.chat?.available === true) {
			// A newly attached bridge has its own revision space. Never merge a delta
			// requested for the previous generation into an empty cache.
			state.chatRevision = null;
			try {
				const fullResponse = await api("/api/state");
				if (fullResponse.status === 401) {
					handleUnauthorized();
					return;
				}
				if (fullResponse.ok) {
					snapshot = await fullResponse.json();
				} else {
					snapshot = { ...snapshot, chat: { available: false } };
				}
			} catch {
				snapshot = { ...snapshot, chat: { available: false } };
			}
		}
		state.generation = snapshot.generation;

		const reloading = snapshot.reloading === true;
		if (state.reloading && !reloading) {
			state.reloading = false;
			elements.reloadButton.disabled = false;
			setReloadState(`Reloaded · browser generation ${snapshot.generation}`, "ok");
		}
		if (reloading) {
			setConnection("Host is reloading extensions…", "notice");
		} else if (generationChanged) {
			setConnection(`Reconnected after reload · generation ${snapshot.generation}`, "online");
		} else {
			setConnection(
				snapshot.pending.length === 0
					? "Connected · no pending prompts"
					: `Connected · ${snapshot.pending.length} pending prompt(s)`,
				"online",
			);
		}
		render(snapshot);
		renderChat(snapshot.chat);
	} catch {
		setConnection("Disconnected from the Pi host — retrying…", "offline");
		state.pollInterval = Math.min(MAX_POLL_INTERVAL_MS, state.pollInterval * 2);
	}
}

function loop() {
	poll().finally(() => {
		setTimeout(loop, state.pollInterval);
	});
}

/* Page switching: a click on a tab, or the tab pattern's own keyboard model (the arrow
   keys and Home/End select and move focus). Selecting a page never fetches anything —
   the page only shows data the poll already delivered. */
for (const [index, page] of PAGES.entries()) {
	page.tab.addEventListener("click", () => selectPage(page.name));
	page.tab.addEventListener("keydown", (event) => {
		const key = event?.key;
		if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") {
			return;
		}
		event.preventDefault();
		const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
		const next =
			key === "Home" ? 0 : key === "End" ? PAGES.length - 1 : (index + step + PAGES.length) % PAGES.length;
		selectPage(PAGES[next].name, { focusTab: true });
	});
}

// The static markup already starts on Chat; this keeps the module state and the DOM in
// step, and makes the default explicit for a page whose markup was edited.
selectPage(state.page);

elements.authForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const token = elements.authInput.value.trim();
	if (!token) {
		return;
	}
	state.token = token;
	sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
	elements.authInput.value = "";
	state.stopped = false;
	state.pollInterval = POLL_INTERVAL_MS;
	hideAuth();
	poll();
});

elements.reload.addEventListener("submit", (event) => {
	event.preventDefault();
	requestReload();
});

elements.subagentsRefresh.addEventListener("click", () => {
	refreshSubagents();
});

elements.chatDelivery.addEventListener("change", () => {
	if (state.chat) {
		renderChat(state.chat);
	}
});

elements.chatForm.addEventListener("submit", (event) => {
	event.preventDefault();
	sendChatMessage();
});

elements.chatStop.addEventListener("click", () => {
	stopChat();
});

// Choosing a model or a thinking level applies it: the selects submit on `change` and
// there is no second confirmation button. Both forms only group label, field and status,
// so an implicit submit (Enter/… on a platform that supports it) must not reload the page.
elements.modelSelect.addEventListener("change", () => {
	submitModel();
});

elements.thinkingSelect.addEventListener("change", () => {
	submitThinking();
});

for (const form of [elements.modelForm, elements.thinkingForm]) {
	form.addEventListener("submit", (event) => {
		event.preventDefault();
	});
}

if (!state.token) {
	showAuth("No token found in this URL. Open the browser URL of the running Pi session.");
	setConnection("Waiting for a token", "notice");
} else {
	setReloadState("", "");
	loop();
}

// Exposed for the manual verification steps and for the static security test.
export {
	TOKEN_STORAGE_KEY,
	requestReload,
	refreshSubagents,
	requestSubagentDetail,
	selectPage,
	sendChatMessage,
	stopChat,
	renderChat,
	renderControls,
	renderStatus,
	renderSubagents,
	submitModel,
	submitThinking,
	state,
};
