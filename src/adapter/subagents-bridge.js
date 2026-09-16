/**
 * Generation-scoped, read-only pi-subagents RPC bridge.
 *
 * This adapter talks only to the public in-process event-bus contract. It never
 * imports pi-subagents, starts a child, reads an artifact, or treats a fleet key
 * as an async run id. The browser receives a bounded projection of the public
 * fleet/status DTOs and can request a transcript only for an async id retained
 * by the current generation's successful status response.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";

export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_CHILD_STATUS_EVENT = "subagent:child-status";

const SUBAGENT_REFRESH_HINT_EVENTS = Object.freeze([
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CHILD_STATUS_EVENT,
]);

export const SUBAGENT_LIMITS = Object.freeze({
	rpcTimeoutMs: 1500,
	maxFleetEntries: 32,
	maxAsyncRuns: 32,
	maxChildrenPerRun: 8,
	maxResultSummaries: 8,
	maxAsyncDepth: 3,
	maxKeyChars: 256,
	maxAgentChars: 128,
	maxRoleChars: 128,
	maxModelChars: 256,
	maxEffortChars: 128,
	maxGoalChars: 512,
	maxLabelChars: 256,
	maxStateChars: 96,
	maxCodeChars: 96,
	maxErrorChars: 512,
	maxDetailTextChars: 32 * 1024,
});

/** Fixed transcript tail passed to every targeted status request. */
export const SUBAGENT_DETAIL_LINES = 80;

const FLEET_TOKEN_FIELDS = Object.freeze(["input", "output", "total"]);
const OUTPUT_STATES = new Set(["present", "absent", "unknown"]);
const BEARER_SECRET = /\bBearer\s+[^\s"'`<>,;)}\]]+/gi;
const SECRET_ASSIGNMENT = /(\b(?:api[-_]?key|access[-_]?key|authorization|credential|private[-_]?key|refresh[-_]?token|key|token|secret|password)\b["']?\s*[:=]\s*)(?:(['"])[^'"\r\n]*\2|([^\s,;}\]\)]+))/gi;
const PATH_LINE = /^\s*(?:async(?:Dir| directory)?|session(?:File| path)?|output(?:File| path)?|cwd|working directory|artifact(?: path)?|events?|logs?|result(?: path)?|file|directory|path)\s*:/i;
const SENSITIVE_PATH_FIELD = /("?(?:asyncDir|sessionFile|transcriptPath|artifactPath|outputFile|eventsPath|logPath|resultPath|cwd)"?\s*[:=]\s*)"?[^,}\r\n]+"?/gi;
const PATH_TOKEN = /(?:[A-Za-z]:[\\/][^\s"'`<>]+|\\\\[^\s"'`<>]+|(?:^|[\s([{"'])\/(?:Users|home|tmp|var|private|workspace|workspaces|agent|async-subagent-runs)[^\s"'`<>]*)/gi;

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value, maxChars) {
	if (value.length <= maxChars) return value;
	if (maxChars <= 1) return value.slice(0, Math.max(0, maxChars));
	return `${value.slice(0, maxChars - 1)}…`;
}

function stripControls(value) {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function stripDetailControls(value) {
	// Keep line boundaries so sensitive artifact/session lines can be dropped as
	// whole records; all other control bytes become harmless spaces.
	return value.replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}

function redactSecretText(value) {
	return value
		.replace(BEARER_SECRET, "Bearer [redacted]")
		.replace(SECRET_ASSIGNMENT, (_match, prefix, quote) => `${prefix}${quote ? `${quote}[redacted]${quote}` : "[redacted]"}`);
}

function redactPathTokens(value) {
	return value.replace(PATH_TOKEN, "[path omitted]");
}

function safeText(value, maxChars, { redactPaths = true } = {}) {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const normalized = stripControls(value);
	const redacted = redactPaths ? redactPathTokens(normalized) : normalized;
	const trimmed = redacted.trim();
	return trimmed ? truncate(trimmed, maxChars) : undefined;
}

function safeCode(value) {
	if (typeof value !== "string" && typeof value !== "number") return "rpc_error";
	const code = String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
	return truncate(code || "rpc_error", SUBAGENT_LIMITS.maxCodeChars);
}

function safeTime(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? Math.min(Number.MAX_SAFE_INTEGER, value)
		: undefined;
}

function safeTokens(value) {
	if (!isRecord(value)) return undefined;
	const tokens = {};
	for (const field of FLEET_TOKEN_FIELDS) {
		const count = safeCount(value[field]);
		if (count !== undefined) tokens[field] = count;
	}
	return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function clone(value) {
	if (Array.isArray(value)) return value.map((entry) => clone(entry));
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function failure(kind, status, code, message) {
	return {
		ok: false,
		kind,
		status,
		code: safeCode(code),
		message: safeText(message, SUBAGENT_LIMITS.maxErrorChars) ?? "pi-subagents RPC failed",
	};
}

function errorForReply(reply) {
	const error = isRecord(reply?.error) ? reply.error : {};
	return failure(
		"rpc_error",
		502,
		error.code,
		error.message,
	);
}

function normalizeSubscription(subscription, events, eventName, handler) {
	if (typeof subscription === "function") return subscription;
	if (subscription && typeof subscription.unsubscribe === "function") return () => subscription.unsubscribe();
	if (subscription && typeof subscription.dispose === "function") return () => subscription.dispose();
	if (typeof events?.off === "function") return () => events.off(eventName, handler);
	if (typeof events?.removeListener === "function") return () => events.removeListener(eventName, handler);
	return () => {};
}

function projectFleetEntry(source) {
	if (!isRecord(source)) return null;
	const key = safeText(source.key, SUBAGENT_LIMITS.maxKeyChars);
	const agent = safeText(source.agent, SUBAGENT_LIMITS.maxAgentChars);
	const startedAt = safeTime(source.startedAt);
	if (!key || !agent || startedAt === undefined) return null;
	const entry = { key, agent, startedAt };
	for (const [sourceKey, targetKey, limit] of [
		["role", "role", SUBAGENT_LIMITS.maxRoleChars],
		["model", "model", SUBAGENT_LIMITS.maxModelChars],
		["effort", "effort", SUBAGENT_LIMITS.maxEffortChars],
		["goal", "goal", SUBAGENT_LIMITS.maxGoalChars],
		["state", "state", SUBAGENT_LIMITS.maxStateChars],
	]) {
		const value = safeText(source[sourceKey], limit);
		if (value) entry[targetKey] = value;
	}
	const tokens = safeTokens(source.tokens);
	if (tokens) entry.tokens = tokens;
	return entry;
}

function projectFleet(source) {
	const rawEntries = Array.isArray(source?.entries) ? source.entries : [];
	const entries = rawEntries
		.slice(0, SUBAGENT_LIMITS.maxFleetEntries)
		.map(projectFleetEntry)
		.filter(Boolean);
	const sourceOmitted = safeCount(source?.omitted) ?? 0;
	const overflow = Math.max(0, rawEntries.length - SUBAGENT_LIMITS.maxFleetEntries);
	const omitted = Math.min(Number.MAX_SAFE_INTEGER, sourceOmitted + overflow + (rawEntries.slice(0, SUBAGENT_LIMITS.maxFleetEntries).length - entries.length));
	return {
		...(source?.version === 1 ? { version: 1 } : {}),
		entries,
		totalActive: safeCount(source?.totalActive) ?? entries.length,
		omitted,
	};
}

function asyncMode(source) {
	const mode = safeText(source?.mode, SUBAGENT_LIMITS.maxStateChars);
	if (mode) return mode;
	return safeText(source?.kind, SUBAGENT_LIMITS.maxStateChars);
}

function projectResultSummary(source) {
	if (!isRecord(source)) return null;
	const summary = {};
	const index = safeCount(source.index);
	if (index !== undefined) summary.index = index;
	for (const [sourceKey, targetKey, limit] of [
		["agent", "agent", SUBAGENT_LIMITS.maxAgentChars],
		["status", "status", SUBAGENT_LIMITS.maxStateChars],
		["model", "model", SUBAGENT_LIMITS.maxModelChars],
		["thinking", "effort", SUBAGENT_LIMITS.maxEffortChars],
		["summary", "summary", SUBAGENT_LIMITS.maxGoalChars],
		["error", "error", SUBAGENT_LIMITS.maxErrorChars],
	]) {
		const value = safeText(source[sourceKey], limit);
		if (value) summary[targetKey] = value;
	}
	if (typeof source.success === "boolean") summary.success = source.success;
	if (typeof source.outputState === "string" && OUTPUT_STATES.has(source.outputState)) summary.outputState = source.outputState;
	return Object.keys(summary).length > 0 ? summary : null;
}

function projectAsyncNode(source, depth = 0, { requireId = true } = {}) {
	if (!isRecord(source)) return null;
	const id = safeText(source.id, SUBAGENT_LIMITS.maxKeyChars);
	if (requireId && !id) return null;
	const node = {};
	if (id) node.id = id;
	const state = safeText(source.state, SUBAGENT_LIMITS.maxStateChars);
	if (state) node.state = state;
	const mode = asyncMode(source);
	if (mode) node.mode = mode;
	for (const [sourceKey, targetKey, limit] of [
		["label", "label", SUBAGENT_LIMITS.maxLabelChars],
		["model", "model", SUBAGENT_LIMITS.maxModelChars],
		["goal", "goal", SUBAGENT_LIMITS.maxGoalChars],
	]) {
		const value = safeText(source[sourceKey], limit);
		if (value) node[targetKey] = value;
	}
	for (const field of ["startedAt", "endedAt"]) {
		const value = safeTime(source[field]);
		if (value !== undefined) node[field] = value;
	}
	const updatedAt = safeTime(source.updatedAt) ?? safeTime(source.lastUpdate);
	if (updatedAt !== undefined) node.updatedAt = updatedAt;
	if (depth < SUBAGENT_LIMITS.maxAsyncDepth && Array.isArray(source.children)) {
		const children = source.children
			.slice(0, SUBAGENT_LIMITS.maxChildrenPerRun)
			.map((child) => projectAsyncNode(child, depth + 1, { requireId: false }))
			.filter(Boolean);
		if (children.length > 0) node.children = children;
	}
	if (Array.isArray(source.results)) {
		const results = source.results
			.slice(0, SUBAGENT_LIMITS.maxResultSummaries)
			.map(projectResultSummary)
			.filter(Boolean);
		if (results.length > 0) node.results = results;
	}
	return Object.keys(node).length > 0 ? node : null;
}

function projectAsyncSnapshot(source) {
	const rawRuns = Array.isArray(source?.runs) ? source.runs : [];
	const runs = rawRuns
		.slice(0, SUBAGENT_LIMITS.maxAsyncRuns)
		.map((run) => projectAsyncNode(run, 0, { requireId: true }))
		.filter(Boolean);
	const sourceOmitted = isRecord(source?.omitted)
		? safeCount(source.omitted.runs) ?? 0
		: safeCount(source?.omitted) ?? 0;
	const overflow = Math.max(0, rawRuns.length - SUBAGENT_LIMITS.maxAsyncRuns);
	const omittedRuns = Math.min(Number.MAX_SAFE_INTEGER, sourceOmitted + overflow + (rawRuns.slice(0, SUBAGENT_LIMITS.maxAsyncRuns).length - runs.length));
	const omittedChildren = isRecord(source?.omitted) ? safeCount(source.omitted.children) ?? 0 : 0;
	const byteLimitExceeded = isRecord(source?.omitted) && source.omitted.byteLimitExceeded === true;
	return {
		...(source?.kind === "pi-subagents.async-status-snapshot" ? { kind: source.kind } : {}),
		...(source?.version === 1 ? { version: 1 } : {}),
		runs,
		omitted: { runs: omittedRuns, children: omittedChildren, byteLimitExceeded },
	};
}

function projectResultSummaries(value) {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, SUBAGENT_LIMITS.maxResultSummaries)
		.map(projectResultSummary)
		.filter(Boolean);
}

function detailText(value) {
	if (typeof value !== "string") return "";
	const raw = stripDetailControls(value)
		.slice(0, SUBAGENT_LIMITS.maxDetailTextChars * 2)
		.replace(SENSITIVE_PATH_FIELD, "$1[path omitted]");
	const lines = [];
	for (const line of raw.split(/\r?\n/)) {
		if (PATH_LINE.test(line)) continue;
		const safe = redactSecretText(line);
		if (safe.trim()) lines.push(safe);
	}
	return truncate(lines.join("\n"), SUBAGENT_LIMITS.maxDetailTextChars);
}

function tinyRunSummary(run) {
	if (!isRecord(run)) return {};
	const summary = {};
	for (const key of ["id", "state", "mode", "label", "model", "goal"]) {
		if (typeof run[key] === "string") summary[key] = run[key];
	}
	for (const key of ["startedAt", "endedAt"]) {
		if (typeof run[key] === "number") summary[key] = run[key];
	}
	const updatedAt = safeTime(run?.updatedAt) ?? safeTime(run?.lastUpdate);
	if (updatedAt !== undefined) summary.updatedAt = updatedAt;
	return summary;
}

/**
 * Read-only public pi-subagents bridge. Construction starts the initial ping ->
 * status sequence; callers can await `bind()` or use `refresh()` for an explicit
 * status-only refresh.
 */
export class SubagentsBridge {
	#events;
	#context;
	#generation;
	#logger;
	#timeoutMs;
	#eventDebounceMs;
	#randomUUID;
	#setTimeout;
	#clearTimeout;
	#active = true;
	#state = "loading";
	#available = false;
	#revision = 0;
	#error = null;
	#fleet = { entries: [], totalActive: 0, omitted: 0 };
	#asyncSnapshot = { runs: [], omitted: { runs: 0, children: 0, byteLimitExceeded: false } };
	#asyncIds = new Set();
	#pending = new Set();
	#hintSubscriptions = [];
	#hintTimer = null;
	#pendingStatusRefresh = false;
	#pendingReadyRecovery = false;
	#inFlight = null;
	#recoveryInFlight = null;
	#initial = null;
	#initialBusy = true;

	constructor({
		events = null,
		eventBus = undefined,
		context = null,
		ctx = undefined,
		generation,
		logger = () => {},
		timeoutMs = SUBAGENT_LIMITS.rpcTimeoutMs,
		rpcTimeoutMs = undefined,
		eventDebounceMs = 0,
		refreshDebounceMs = undefined,
		initialSnapshot = null,
		retainedSnapshot = undefined,
		randomUUID = nodeRandomUUID,
		setTimeout: setTimer = globalThis.setTimeout,
		clearTimeout: clearTimer = globalThis.clearTimeout,
	} = {}) {
		this.#events = eventBus ?? events;
		this.#context = ctx ?? context;
		this.#generation = generation;
		this.#logger = logger;
		const configuredTimeout = rpcTimeoutMs ?? timeoutMs;
		this.#timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
			? Math.min(30_000, Math.floor(configuredTimeout))
			: SUBAGENT_LIMITS.rpcTimeoutMs;
		const configuredDebounce = refreshDebounceMs ?? eventDebounceMs;
		this.#eventDebounceMs = Number.isFinite(configuredDebounce) && configuredDebounce >= 0
			? Math.min(30_000, Math.floor(configuredDebounce))
			: 0;
		this.#randomUUID = typeof randomUUID === "function" ? randomUUID : nodeRandomUUID;
		this.#setTimeout = typeof setTimer === "function" ? setTimer : globalThis.setTimeout;
		this.#clearTimeout = typeof clearTimer === "function" ? clearTimer : globalThis.clearTimeout;
		this.#seedSnapshot(retainedSnapshot ?? initialSnapshot);
		const initial = this.#initialize();
		this.#initial = initial.finally(() => {
			this.#initialBusy = false;
			this.#drainHintQueue();
		});
		void this.#initial.catch(() => {});
	}

	get generation() {
		return this.#generation;
	}

	get detailLines() {
		return SUBAGENT_DETAIL_LINES;
	}

	/** Promise for the initial ping -> untargeted status bind. */
	bind() {
		return this.#initial ?? Promise.resolve(this.snapshot());
	}

	/** Explicit refresh: status only. It never emits ping or any management call. */
	refresh() {
		if (!this.#active) return Promise.resolve(this.snapshot());
		if (this.#initialBusy || this.#inFlight) return this.#inFlight ?? this.#initial ?? Promise.resolve(this.snapshot());
		this.#state = "loading";
		this.#available = false;
		this.#error = null;
		this.#revision += 1;
		return this.#requestStatus();
	}

	/** Return a defensive, bounded snapshot for `/api/state`. */
	snapshot() {
		return {
			available: this.#available,
			state: this.#state,
			generation: this.#generation,
			fleet: clone(this.#fleet),
			asyncSnapshot: clone(this.#asyncSnapshot),
			error: this.#error ? { ...this.#error } : null,
			revision: this.#revision,
		};
	}

	#seedSnapshot(source) {
		if (!isRecord(source)) return;
		try {
			// Retained rows are continuity-only display data. Until this generation's
			// bind succeeds, availability and status must remain non-authoritative.
			this.#available = false;
			this.#state = "loading";
			this.#error = null;
			this.#fleet = projectFleet(source.fleet);
			this.#asyncSnapshot = projectAsyncSnapshot(source.asyncSnapshot);
			// Retained DTOs keep reconnect rendering continuous, but their ids are
			// not an allowlist for targeted details in the new generation.
			this.#asyncIds.clear();
			const revision = safeCount(source.revision);
			if (revision !== undefined) this.#revision = revision;
		} catch {
			// A retained snapshot is only continuity data; a malformed seed must not
			// prevent the new generation from performing its authoritative bind.
		}
	}

	#subscribeHintEvents() {
		const events = this.#events;
		if (!events || typeof events.on !== "function") return;
		for (const eventName of SUBAGENT_REFRESH_HINT_EVENTS) {
			const handler = () => this.#handleHint(eventName);
			try {
				const subscription = events.on(eventName, handler);
				this.#hintSubscriptions.push(normalizeSubscription(subscription, events, eventName, handler));
			} catch (error) {
				try {
					this.#logger(`could not subscribe to pi-subagents event ${eventName}: ${error instanceof Error ? error.message : String(error)}`);
				} catch {
					// Logging is best effort while the host is attaching or tearing down.
				}
			}
		}
	}

	#handleHint(eventName) {
		if (!this.#active) return;
		if (eventName === SUBAGENT_RPC_READY_EVENT) {
			if (this.#available) return;
			this.#pendingReadyRecovery = true;
		} else {
			this.#pendingStatusRefresh = true;
		}
		this.#scheduleHintDrain();
	}

	#scheduleHintDrain() {
		if (!this.#active || this.#hintTimer !== null) return;
		this.#hintTimer = true;
		try {
			const timer = this.#setTimeout(() => {
				this.#hintTimer = null;
				this.#drainHintQueue();
			}, this.#eventDebounceMs);
			if (this.#hintTimer !== null) this.#hintTimer = timer ?? true;
			timer?.unref?.();
		} catch {
			this.#hintTimer = null;
			this.#drainHintQueue();
		}
	}

	#drainHintQueue() {
		if (!this.#active || this.#initialBusy || this.#recoveryInFlight || this.#inFlight) return;
		if (this.#available) this.#pendingReadyRecovery = false;
		if (this.#pendingReadyRecovery) {
			this.#pendingReadyRecovery = false;
			// The ping -> status recovery is itself the authoritative refresh for
			// all hints queued while availability was lost.
			this.#pendingStatusRefresh = false;
			this.#startReadyRecovery();
			return;
		}
		if (this.#pendingStatusRefresh) {
			this.#pendingStatusRefresh = false;
			this.#requestStatus();
		}
	}

	#startReadyRecovery() {
		if (!this.#active || this.#recoveryInFlight || this.#initialBusy || this.#inFlight) return;
		let promise;
		promise = (async () => {
			const ping = await this.#requestRpc("ping", {});
			if (!this.#active) return this.snapshot();
			if (!ping.ok) {
				this.#applyFailure(ping);
				return this.snapshot();
			}
			if (!isRecord(ping.data)) {
				this.#applyFailure(failure("invalid_reply", 502, "invalid_reply", "pi-subagents ping returned invalid data"));
				return this.snapshot();
			}
			return this.#requestStatus();
		})().finally(() => {
			if (this.#recoveryInFlight === promise) this.#recoveryInFlight = null;
			this.#drainHintQueue();
		});
		this.#recoveryInFlight = promise;
	}

	/** Read one allowlisted async run transcript; never accepts a fleet key. */
	detail(expectedGeneration, body = {}) {
		if (!this.#active || expectedGeneration !== this.#generation) {
			return Promise.resolve(failure("stale_generation", 409, "stale_generation", "the browser session generation is no longer current"));
		}
		if (!isRecord(body) || Object.keys(body).some((key) => key !== "generation" && key !== "id")) {
			return Promise.resolve(failure("invalid_body", 400, "invalid_body", "subagent details only accept the current generation and async run id"));
		}
		if (body.generation !== this.#generation) {
			return Promise.resolve(failure("stale_generation", 409, "stale_generation", "the browser session generation is no longer current"));
		}
		const id = safeText(body.id, SUBAGENT_LIMITS.maxKeyChars, { redactPaths: false });
		if (!id || !this.#asyncIds.has(id)) {
			return Promise.resolve(failure("not_found", 404, "not_found", "the requested async run is not in the current status allowlist"));
		}
		return this.#requestRpc("status", { id, view: "transcript", lines: SUBAGENT_DETAIL_LINES }).then((reply) => {
			if (!this.#active) return failure("stale_generation", 409, "stale_generation", "the browser session generation is no longer current");
			if (!reply.ok) return reply;
			if (!isRecord(reply.data)) return failure("invalid_reply", 502, "invalid_reply", "pi-subagents returned no status data");
			try {
				const run = this.#asyncSnapshot.runs.find((candidate) => candidate.id === id);
				const summary = tinyRunSummary(run);
				const results = projectResultSummaries(reply.data.details?.results);
				if (results.length > 0) summary.results = results;
				return {
					ok: true,
					id,
					text: detailText(reply.data.text),
					summary,
				};
			} catch (error) {
				return failure("invalid_reply", 502, "invalid_reply", error instanceof Error ? error.message : String(error));
			}
		});
	}

	dispose() {
		if (!this.#active) return;
		this.#active = false;
		if (this.#hintTimer !== null) {
			try { this.#clearTimeout(this.#hintTimer); } catch { /* best effort */ }
			this.#hintTimer = null;
		}
		for (const unsubscribe of this.#hintSubscriptions.splice(0)) {
			try { unsubscribe(); } catch { /* best effort */ }
		}
		this.#pendingStatusRefresh = false;
		this.#pendingReadyRecovery = false;
		this.#recoveryInFlight = null;
		for (const pending of [...this.#pending]) {
			pending.cancel();
		}
		this.#pending.clear();
		this.#events = null;
		this.#context = null;
		this.#logger = () => {};
		this.#asyncIds.clear();
		this.#error = null;
		this.#state = "unavailable";
		this.#available = false;
		this.#revision += 1;
	}

	async #initialize() {
		if (!this.#active) return this.snapshot();
		if (!this.#events || typeof this.#events.on !== "function" || typeof this.#events.emit !== "function") {
			this.#applyFailure(failure("unavailable", 503, "rpc_unavailable", "pi-subagents in-process RPC is unavailable"));
			return this.snapshot();
		}
		this.#subscribeHintEvents();
		const ping = await this.#requestRpc("ping", {});
		if (!this.#active) return this.snapshot();
		if (!ping.ok) {
			this.#applyFailure(ping);
			return this.snapshot();
		}
		if (!isRecord(ping.data)) {
			const invalid = failure("invalid_reply", 502, "invalid_reply", "pi-subagents ping returned invalid data");
			this.#applyFailure(invalid);
			return this.snapshot();
		}
		// Capability metadata is intentionally not forwarded. The subsequent status
		// projection is safe even when an older compatible owner omits this field.
		return this.#requestStatus();
	}

	#requestStatus() {
		if (!this.#active) return Promise.resolve(this.snapshot());
		if (this.#inFlight) return this.#inFlight;
		let promise;
		promise = this.#requestRpc("status", {}).then((reply) => {
			if (!this.#active) return this.snapshot();
			if (!reply.ok) {
				this.#applyFailure(reply);
				return this.snapshot();
			}
			if (!isRecord(reply.data)) {
				this.#applyFailure(failure("invalid_reply", 502, "invalid_reply", "pi-subagents status returned invalid data"));
				return this.snapshot();
			}
			try {
				this.#applyStatus(reply.data);
			} catch (error) {
				this.#applyFailure(failure("invalid_reply", 502, "invalid_reply", error instanceof Error ? error.message : String(error)));
			}
			return this.snapshot();
		}).finally(() => {
			if (this.#inFlight === promise) this.#inFlight = null;
			this.#drainHintQueue();
		});
		this.#inFlight = promise;
		return promise;
	}

	#applyStatus(data) {
		const fleet = projectFleet(data.fleet);
		const asyncSnapshot = projectAsyncSnapshot(data.asyncSnapshot);
		this.#fleet = fleet;
		this.#asyncSnapshot = asyncSnapshot;
		this.#asyncIds = new Set(asyncSnapshot.runs.map((run) => run.id).filter((id) => typeof id === "string"));
		this.#available = true;
		this.#error = null;
		const hasOmittedData = fleet.omitted > 0
			|| asyncSnapshot.omitted.runs > 0
			|| asyncSnapshot.omitted.children > 0
			|| asyncSnapshot.omitted.byteLimitExceeded === true;
		this.#state = fleet.entries.length > 0 || asyncSnapshot.runs.length > 0 || hasOmittedData ? "ready-data" : "ready-empty";
		this.#revision += 1;
	}

	#applyFailure(result) {
		if (!this.#active) return;
		this.#asyncIds.clear();
		this.#available = false;
		this.#error = {
			kind: result.kind ?? "rpc_error",
			code: safeCode(result.code),
			message: safeText(result.message, SUBAGENT_LIMITS.maxErrorChars) ?? "pi-subagents RPC failed",
		};
		this.#state = result.kind === "timeout" || result.kind === "unavailable" ? "unavailable" : "error";
		this.#revision += 1;
	}

	#requestRpc(method, params) {
		if (!this.#active) return Promise.resolve(failure("stale_generation", 409, "stale_generation", "the browser session generation is no longer current"));
		const events = this.#events;
		if (!events || typeof events.on !== "function" || typeof events.emit !== "function") {
			return Promise.resolve(failure("unavailable", 503, "rpc_unavailable", "pi-subagents in-process RPC is unavailable"));
		}
		let requestId;
		try {
			requestId = String(this.#randomUUID());
		} catch (error) {
			return Promise.resolve(failure("unavailable", 503, "rpc_unavailable", error instanceof Error ? error.message : String(error)));
		}
		const eventName = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
		return new Promise((resolve) => {
			let settled = false;
			let timer = null;
			let unsubscribe = () => {};
			const pending = {
				cancel: () => settle(failure("stale_generation", 409, "stale_generation", "the browser session generation is no longer current")),
			};
			const settle = (result) => {
				if (settled) return;
				settled = true;
				if (timer !== null) {
					try { this.#clearTimeout(timer); } catch { /* best effort */ }
					timer = null;
				}
				try { unsubscribe(); } catch { /* best effort */ }
				this.#pending.delete(pending);
				resolve(result);
			};
			const handler = (raw) => {
				if (!this.#active || settled || !isRecord(raw)) return;
				if (raw.version !== SUBAGENT_RPC_PROTOCOL_VERSION || raw.requestId !== requestId) return;
				if (raw.success === true) {
					settle({ ok: true, data: raw.data });
					return;
				}
				if (raw.success === false) {
					settle(errorForReply(raw));
					return;
				}
				settle(failure("invalid_reply", 502, "invalid_reply", "pi-subagents returned an invalid RPC envelope"));
			};
			this.#pending.add(pending);
			try {
				const subscription = events.on(eventName, handler);
				unsubscribe = normalizeSubscription(subscription, events, eventName, handler);
			} catch (error) {
				settle(failure("unavailable", 503, "rpc_unavailable", error instanceof Error ? error.message : String(error)));
				return;
			}
			try {
				timer = this.#setTimeout(() => settle(failure("timeout", 504, "timeout", `pi-subagents RPC timed out: ${method}`)), this.#timeoutMs);
				timer?.unref?.();
			} catch (error) {
				settle(failure("unavailable", 503, "rpc_unavailable", error instanceof Error ? error.message : String(error)));
				return;
			}
			try {
				events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
					version: SUBAGENT_RPC_PROTOCOL_VERSION,
					requestId,
					method,
					params,
				});
			} catch (error) {
				settle(failure("unavailable", 503, "rpc_unavailable", error instanceof Error ? error.message : String(error)));
			}
		});
	}
}

export function subagentReplyEvent(requestId) {
	return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

export { detailText, projectAsyncSnapshot, projectFleet, projectResultSummary };
