/**
 * Browser client for the Pi browser-interaction prototype.
 *
 * Vanilla ES module, no dependencies, no CDN. All values coming from the host are
 * rendered with textContent (never innerHTML) so prompt text is displayed as text.
 * The token is read from the URL fragment (#t=…) and kept in sessionStorage; it is
 * sent to the loopback bridge as an Authorization header only.
 */

const TOKEN_STORAGE_KEY = "pi-browser-ui-token";
const POLL_INTERVAL_MS = 600;
const MAX_POLL_INTERVAL_MS = 5000;

const elements = {
	connection: document.getElementById("connection"),
	statusState: document.getElementById("status-state"),
	statusCwd: document.getElementById("status-cwd"),
	statusBranch: document.getElementById("status-branch"),
	statusTokens: document.getElementById("status-tokens"),
	statusContext: document.getElementById("status-context"),
	subagentsState: document.getElementById("subagents-state"),
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
	modelApply: document.getElementById("model-apply"),
	modelStatus: document.getElementById("model-status"),
	thinkingForm: document.getElementById("thinking-form"),
	thinkingSelect: document.getElementById("thinking-select"),
	thinkingApply: document.getElementById("thinking-apply"),
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
	return [
		`in ${formatStatusNumber(tokens.input)}`,
		`out ${formatStatusNumber(tokens.output)}`,
		`total ${formatStatusNumber(tokens.total)}`,
	].join(" · ");
}

function appendSubagentText(parent, className, text) {
	const node = document.createElement("p");
	node.className = className;
	node.textContent = text;
	parent.append(node);
	return node;
}

function renderFleetEntry(entry) {
	const card = document.createElement("article");
	card.className = "subagent-entry";
	const title = document.createElement("h4");
	title.className = "subagent-entry-title";
	title.textContent = `Fleet entry ${subagentValue(entry.key)}`;
	card.append(title);
	appendSubagentText(card, "subagent-entry-meta", [
		`agent: ${subagentValue(entry.agent)}`,
		`role: ${subagentValue(entry.role)}`,
		`model: ${subagentValue(entry.model)}`,
		`effort: ${subagentValue(entry.effort)}`,
		`state: ${subagentValue(entry.state)}`,
		`tokens: ${subagentTokensText(entry.tokens)}`,
		`started: ${subagentTime(entry.startedAt)}`,
	].join(" · "));
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

function renderAsyncRun(run) {
	const card = document.createElement("article");
	card.className = "subagent-run";
	const title = document.createElement("h4");
	title.className = "subagent-run-title";
	title.textContent = run.label ? `${run.label} (${subagentValue(run.id)})` : `Async run ${subagentValue(run.id)}`;
	card.append(title);
	appendSubagentText(card, "subagent-run-meta", [
		`state: ${subagentValue(run.state)}`,
		`mode: ${subagentValue(run.mode)}`,
		`model: ${subagentValue(run.model)}`,
		`started: ${subagentTime(run.startedAt)}`,
		`last update: ${subagentTime(run.updatedAt)}`,
		`ended: ${subagentTime(run.endedAt)}`,
	].join(" · "));
	if (run.goal) appendSubagentText(card, "subagent-run-goal", `goal: ${run.goal}`);
	const actions = document.createElement("div");
	actions.className = "subagent-run-actions";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "primary";
	button.textContent = "View transcript";
	const result = document.createElement("p");
	result.className = "subagent-run-meta";
	result.dataset.state = "";
	button.addEventListener("click", () => requestSubagentDetail(card, run.id, button, result));
	actions.append(button, result);
	card.append(actions);
	renderSummaryList(card, "Child summaries", run.children, "subagent-children");
	renderSummaryList(card, "Result summaries", run.results, "subagent-results");
	return card;
}

function subagentsStatusText(snapshot) {
	if (!snapshot || typeof snapshot !== "object") return ["Unavailable", "unavailable", "Subagent status is not attached to the current Pi session."];
	if (snapshot.state === "loading") return ["Loading", "loading", "Loading read-only pi-subagents status…"];
	if (snapshot.state === "ready-empty") {
		const fleetOmitted = snapshot.fleet?.omitted ?? 0;
		const asyncOmitted = snapshot.asyncSnapshot?.omitted?.runs ?? 0;
		const omitted = fleetOmitted + asyncOmitted;
		return ["Ready · empty", "ready", omitted > 0 ? `No visible entries; ${omitted} entry/run item(s) were omitted or truncated.` : "No fleet entries or async runs are active."];
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

/** Render the bounded fleet and async-run DTO projection; refresh is explicit only. */
function renderSubagents(snapshot) {
	state.subagentsSnapshot = snapshot && typeof snapshot === "object" ? snapshot : null;
	state.subagentsGeneration = state.generation;
	const [label, stateName, message] = subagentsStatusText(state.subagentsSnapshot);
	elements.subagentsState.textContent = label;
	elements.subagentsState.dataset.state = stateName;
	elements.subagentsStatus.textContent = message;
	elements.subagentsStatus.dataset.state = stateName === "error" ? "error" : stateName === "ready" ? "ok" : "";
	elements.subagentsRefresh.disabled = state.generation === null || state.reloading || state.subagentsRefreshing;
	clearElement(elements.subagentsFleet);
	clearElement(elements.subagentsAsync);
	const fleetEntries = Array.isArray(state.subagentsSnapshot?.fleet?.entries) ? state.subagentsSnapshot.fleet.entries : [];
	const asyncRuns = Array.isArray(state.subagentsSnapshot?.asyncSnapshot?.runs) ? state.subagentsSnapshot.asyncSnapshot.runs : [];
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

function renderControls(controls) {
	if (!controls || controls.available !== true) {
		elements.controlsState.textContent = "Unavailable";
		elements.modelCurrent.textContent = "Current model: unavailable";
		elements.modelSelect.textContent = "";
		elements.thinkingSelect.textContent = "";
		elements.modelSelect.disabled = true;
		elements.modelApply.disabled = true;
		elements.thinkingSelect.disabled = true;
		elements.thinkingApply.disabled = true;
		state.controls = null;
		return;
	}

	const candidates = Array.isArray(controls.candidates) ? controls.candidates : [];
	const currentKey = controls.model && typeof controls.model.provider === "string" && typeof controls.model.id === "string"
		? `${controls.model.provider}/${controls.model.id}`
		: "";
	elements.controlsState.textContent = state.reloading ? "Reloading…" : "Connected";
	elements.modelCurrent.textContent = `Current model: ${modelLabel(controls.model)}`;
	elements.modelSelect.textContent = "";
	for (const candidate of candidates) {
		if (!candidate || typeof candidate.key !== "string") {
			continue;
		}
		const option = document.createElement("option");
		option.value = candidate.key;
		const thinking = typeof candidate.thinkingLevel === "string" ? ` · thinking ${candidate.thinkingLevel}` : "";
		option.textContent = `${modelLabel(candidate)}${thinking}`;
		elements.modelSelect.append(option);
	}
	if (currentKey && candidates.some((candidate) => candidate?.key === currentKey)) {
		elements.modelSelect.value = currentKey;
	} else {
		elements.modelSelect.value = "";
	}

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
	if (typeof controls.thinkingLevel === "string" && levels.includes(controls.thinkingLevel)) {
		elements.thinkingSelect.value = controls.thinkingLevel;
	} else {
		elements.thinkingSelect.value = "";
	}

	const disabled = state.reloading;
	elements.modelSelect.disabled = disabled || candidates.length === 0 || state.modelSending;
	elements.modelApply.disabled = disabled || candidates.length === 0 || state.modelSending;
	elements.thinkingSelect.disabled = disabled || levels.length === 0 || state.thinkingSending;
	elements.thinkingApply.disabled = disabled || levels.length === 0 || state.thinkingSending;
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
	await submitControl("/api/model", { key }, "model");
}

async function submitThinking() {
	const level = elements.thinkingSelect.value;
	if (!FALLBACK_THINKING_LEVELS.includes(level)) {
		setControlStatus(elements.thinkingStatus, "Choose an allowed thinking level first.", "error");
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
	for (const child of [...container.children]) {
		child.remove();
	}

	const blocks = Array.isArray(message.blocks) ? message.blocks : [];
	let rendered = 0;
	let hasVisibleText = false;
	let hasToolResult = false;
	blocks.forEach((block, index) => {
		if (!block || typeof block !== "object") {
			return;
		}
		if (block.type === "text") {
			const text = document.createElement("p");
			text.className = "chat-text";
			text.textContent = typeof block.text === "string" ? block.text : "";
			container.append(text);
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
		container.append(blockDetails(block, key, previousOpen.has(key) ? previousOpen.get(key) : defaultOpen));
		rendered += 1;
	});

	if (rendered === 0 || (typeof message.text === "string" && message.text.length > 0 && !hasVisibleText && !hasToolResult)) {
		const text = document.createElement("p");
		text.className = "chat-text";
		text.textContent = typeof message.text === "string" ? message.text : "";
		container.append(text);
	}
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
		if (existing) {
			if (revision === null || state.chatRenderedRevisions.get(message.id) !== revision) {
				updateChatCard(existing, message);
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
			card.remove();
			state.chatRendered.delete(id);
			state.chatRenderedRevisions.delete(id);
		}
	}
	reorderChatCards(cards);
	elements.chatEmpty.classList.toggle("hidden", state.chatRendered.size > 0);
	if (state.chatRendered.size > 0) {
		elements.chatEmpty.textContent = "No chat messages yet.";
	}
	state.chat = chat;
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

elements.modelForm.addEventListener("submit", (event) => {
	event.preventDefault();
	submitModel();
});

elements.thinkingForm.addEventListener("submit", (event) => {
	event.preventDefault();
	submitThinking();
});

if (!state.token) {
	showAuth("No token found in this URL. Open the browser URL of the running Pi session.");
	setConnection("Waiting for a token", "notice");
} else {
	setReloadState("Idle", "");
	loop();
}

// Exposed for the manual verification steps and for the static security test.
export {
	TOKEN_STORAGE_KEY,
	requestReload,
	refreshSubagents,
	requestSubagentDetail,
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
