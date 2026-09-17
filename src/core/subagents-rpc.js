/**
 * Generation-scoped, read-only pi-subagents RPC consumer.
 *
 * Moved verbatim from the removed private-seam adapter (`src/adapter/subagents-bridge.js`)
 * when that path was removed: `src/host/subagents.js` wraps this implementation over the
 * host-owned extension event bus, so the public RPC envelope, DTO bounds and redaction
 * rules stay a single implementation with no second copy.
 *
 * It talks only to the public in-process event-bus contract. It never imports
 * pi-subagents, starts a child, reads an artifact, or treats a fleet key as an async
 * run id. The browser receives a bounded projection of the public fleet/status DTOs, can
 * request a transcript only for an async id retained by the current generation's
 * successful status response, and can ask for the *structured* view of one retained run
 * (or of one child node of the current snapshot) through the extension's own
 * `/subagents-inspect-rpc` command, whose widget payload is correlated by request id and
 * projected by `src/core/inspect-reply.js`.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";

import {
	INSPECT_COMMAND_NAME,
	INSPECT_LIMITS,
	boundedInspectLines,
	isValidInspectRequestId,
	parseInspectWidgetLine,
	projectInspectReply,
} from "./inspect-reply.js";
import {
	PATH_LINE,
	isRecord,
	redactSecretText,
	redactSensitivePathFields,
	safeCode as sharedSafeCode,
	safeText,
	stripDetailControls,
	truncate,
} from "./redaction.js";

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
	/** Default deadline for one structured inspection round trip. */
	inspectTimeoutMs: 5000,
	maxInspectChildIdChars: 256,
	/** Chat-attributed async run ids kept inspectable outside the bounded status snapshot. */
	maxReferencedAsyncIds: 64,
});

/** Opaque id shape accepted from the chat projection into the inspect allow-list. */
const REFERENCED_ASYNC_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Fixed transcript tail passed to every targeted status request. */
export const SUBAGENT_DETAIL_LINES = 80;

/** Structured-inspection body allow-list (the only fields `/api/subagents/inspect` accepts). */
export const SUBAGENT_INSPECT_BODY_KEYS = Object.freeze(["generation", "id", "childId", "lines"]);

const INSPECT_BODY_KEYS = new Set(SUBAGENT_INSPECT_BODY_KEYS);

/**
 * pi-subagents error codes the browser can act on, mapped to the HTTP status the page
 * receives. `internal` and every unknown code become `inspect_failed` (502) with the
 * extension's bounded message preserved.
 */
const INSPECT_ERROR_STATUS = Object.freeze({
	invalid_request: 400,
	foreign_session: 403,
	not_found: 404,
	stale: 409,
	no_active_session: 503,
});

/**
 * Failure codes this bridge raises itself (no browser-actionable extension code): the
 * command is unavailable, another inspection is already in flight, the extension did not
 * answer in time, or the captured reply could not be trusted.
 */
export const SUBAGENT_INSPECT_FAILURES = Object.freeze({
	unavailable: [503, "inspect_unavailable"],
	commandsUnavailable: [503, "commands_unavailable"],
	busy: [409, "inspect_busy"],
	timeout: [504, "inspect_timeout"],
	failed: [502, "inspect_failed"],
});

/* `window` is the child's current context size (input + cache read) and `windowPeak` its
   peak, so the rail can show live context pressure instead of only cumulative tokens. */
const FLEET_TOKEN_FIELDS = Object.freeze(["input", "output", "total", "window", "windowPeak"]);
const OUTPUT_STATES = new Set(["present", "absent", "unknown"]);

/** The shared redaction helper, bounded by this module's own code limit. */
function safeCode(value) {
	return sharedSafeCode(value, { fallback: "rpc_error", maxChars: SUBAGENT_LIMITS.maxCodeChars });
}

/** Bounded, path-free text for a thrown value (used in failure messages only). */
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
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

/**
 * Which failure to report when the structured inspect refused an id and the transcript
 * fallback could not answer either. A specific extension code from the fallback (a foreign
 * session, a run whose artifacts are gone, an index the extension needs) says more than the
 * generic refusal, while a second `not_found` says nothing new and must not replace it.
 */
function preferInspectFailure(primary, fallback) {
	if (fallback && fallback.ok === false && typeof fallback.code === "string" && fallback.code !== "not_found") {
		return fallback;
	}
	return primary;
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
	const raw = redactSensitivePathFields(
		stripDetailControls(value).slice(0, SUBAGENT_LIMITS.maxDetailTextChars * 2),
	);
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
	/** Async run ids the chat projection attributed to a `subagent` tool result.
	 *  Bounded and FIFO: a chat row may point at a run that already left the bounded status
	 *  snapshot, and the page still must not be able to name ids the host never reported. */
	#referencedAsyncIds = new Set();
	#pending = new Set();
	#hintSubscriptions = [];
	#hintTimer = null;
	#pendingStatusRefresh = false;
	#pendingReadyRecovery = false;
	#inFlight = null;
	#recoveryInFlight = null;
	#inspectRunner = null;
	#inspectTimeoutMs = SUBAGENT_LIMITS.inspectTimeoutMs;
	#inspectInFlight = false;
	#inspectAbort = null;
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
		inspectRunner = null,
		inspectTimeoutMs = undefined,
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
		this.#inspectRunner = typeof inspectRunner === "function" ? inspectRunner : null;
		this.#inspectTimeoutMs = Number.isFinite(inspectTimeoutMs) && inspectTimeoutMs > 0
			? Math.min(30_000, Math.floor(inspectTimeoutMs))
			: SUBAGENT_LIMITS.inspectTimeoutMs;
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

	/** Bounded deadline for one structured inspection round trip. */
	get inspectTimeoutMs() {
		return this.#inspectTimeoutMs;
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
			// Count only: the ids stay host-side. A chat-attributed delegation can leave the active
			// fleet entirely, so this tells the rail that its "nothing is active" line does not mean
			// "nothing is readable" — the run's own chat row is still addressable.
			referencedRuns: this.#referencedAsyncIds.size,
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

	/**
	 * Whether one run id may be named by this generation at all: a run the current status
	 * snapshot retains, or an id the chat attributed to a subagent tool result. Host-owned
	 * readers that do not go through pi-subagents (the child session file) must ask this
	 * before touching anything, so the browser cannot widen what it is allowed to read.
	 */
	permitsRunId(id) {
		const candidate = safeText(id, SUBAGENT_LIMITS.maxKeyChars, { redactPaths: false });
		if (!candidate || candidate !== id) return false;
		return this.#asyncIds.has(candidate) || this.#referencedAsyncIds.has(candidate);
	}

	/**
	 * Record async run ids the chat projection attributed to a `subagent` tool result, so a
	 * chat row can be inspected even when the run already left the bounded status snapshot.
	 * Bounded and FIFO; unknown, malformed and duplicate ids are ignored.
	 */
	retainReferencedAsyncIds(ids) {
		if (!Array.isArray(ids) || ids.length === 0) {
			return 0;
		}
		let added = 0;
		for (const candidate of ids) {
			const id = safeText(candidate, SUBAGENT_LIMITS.maxKeyChars, { redactPaths: false });
			// Only opaque id shapes are retained: a caller must not be able to park a
			// path-looking string in the allow-list for the inspect command to carry.
			if (!id || id !== candidate || !REFERENCED_ASYNC_ID.test(id) || this.#asyncIds.has(id) || this.#referencedAsyncIds.has(id)) {
				continue;
			}
			this.#referencedAsyncIds.add(id);
			added += 1;
			while (this.#referencedAsyncIds.size > SUBAGENT_LIMITS.maxReferencedAsyncIds) {
				const oldest = this.#referencedAsyncIds.values().next().value;
				this.#referencedAsyncIds.delete(oldest);
			}
		}
		return added;
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

	/**
	 * Read the *structured* view of one retained async run (or of one child node of the
	 * current snapshot) through the extension's own host command.
	 *
	 * The command is executed by `session.prompt()`'s extension-command dispatch, so it
	 * produces no model turn and writes no chat history; the reply arrives as one captured
	 * `subagent-inspect` widget payload and is correlated by this call's request id. Only
	 * ids the current generation's successful status response returned are accepted, exactly
	 * like `detail()`: a fleet display key, an unknown child node, an unusable line count or
	 * a second inspection of the same generation is refused before anything reaches the
	 * session. The deadline, the single in-flight slot and every failure code are explicit —
	 * a timeout never retries and never touches an in-flight chat turn.
	 *
	 * The reply describes what the extension could actually serve: an async run comes back as
	 * the structured view (`task`/`messages`/`finalOutput`), while a blocking (foreground)
	 * delegation — which the extension refuses to inspect — comes back as
	 * `{ kind: "transcript", runId, lines, text }` from its own status action.
	 *
	 * @param {number} expectedGeneration generation the browser believes is current
	 * @param {{ generation?: number, id?: string, childId?: string, lines?: number }} [body]
	 * @returns {Promise<{ ok: true, generation: number, inspect: object } | { ok: false, status: number, code: string, message: string }>}
	 */
	inspect(expectedGeneration, body = {}) {
		if (!this.#active || expectedGeneration !== this.#generation) {
			return Promise.resolve(failure("stale_generation", 409, "stale_generation", "the browser session generation is no longer current"));
		}
		if (!isRecord(body) || Object.keys(body).some((key) => !INSPECT_BODY_KEYS.has(key))) {
			return Promise.resolve(failure("invalid_body", 400, "invalid_body", "subagent inspection only accepts the current generation, an async run id, an optional child id and an optional line count"));
		}
		if (body.generation !== this.#generation) {
			return Promise.resolve(failure("stale_generation", 409, "stale_generation", "the browser session generation is no longer current"));
		}
		const id = safeText(body.id, SUBAGENT_LIMITS.maxKeyChars, { redactPaths: false });
		if (!id || !(this.#asyncIds.has(id) || this.#referencedAsyncIds.has(id))) {
			return Promise.resolve(failure("not_found", 404, "not_found", "the requested async run is not in the current status allowlist"));
		}
		let childId;
		if (body.childId !== undefined) {
			childId = safeText(body.childId, SUBAGENT_LIMITS.maxInspectChildIdChars, { redactPaths: false });
			if (!childId || childId !== body.childId) {
				return Promise.resolve(failure("invalid_body", 400, "invalid_body", "a child node id must be a non-empty, bounded node id"));
			}
			if (!this.#hasChildId(id, childId)) {
				return Promise.resolve(failure("not_found", 404, "not_found", "the requested child node is not in the current async status snapshot"));
			}
		}
		let lines;
		if (body.lines !== undefined) {
			lines = boundedInspectLines(body.lines);
			if (lines === undefined) {
				return Promise.resolve(failure(
					"invalid_body",
					400,
					"invalid_body",
					`an inspection line count must be an integer between ${INSPECT_LIMITS.minLines} and ${INSPECT_LIMITS.maxLines}`,
				));
			}
		}
		if (typeof this.#inspectRunner !== "function") {
			return Promise.resolve(this.#inspectFailure("unavailable", "this host session has no pi-subagents inspect command channel"));
		}
		if (this.#inspectInFlight) {
			return Promise.resolve(this.#inspectFailure("busy", "an inspection of this generation is already in flight; wait for its answer"));
		}
		const requestId = this.#newInspectRequestId();
		if (requestId === null) {
			return Promise.resolve(this.#inspectFailure("unavailable", "this host could not generate an inspect request id"));
		}
		const commandText = subagentInspectCommand(requestId, id, childId, lines);
		this.#inspectInFlight = true;
		// The transport owns its widget subscription; the signal lets it release that
		// subscription the moment this call stops waiting (deadline, dispose, answer).
		const controller = typeof AbortController === "function" ? new AbortController() : null;
		this.#inspectAbort = controller;
		return new Promise((resolve) => {
			let settled = false;
			let timer = null;
			const clearDeadline = () => {
				if (timer === null) return;
				try { this.#clearTimeout(timer); } catch { /* best effort */ }
				timer = null;
			};
			const finish = (value) => {
				if (settled) return;
				settled = true;
				clearDeadline();
				try { controller?.abort(); } catch { /* best effort */ }
				if (this.#inspectAbort === controller) this.#inspectAbort = null;
				this.#inspectInFlight = false;
				resolve(this.#active
					? value
					: failure("stale_generation", 409, "stale_generation", "the browser session generation is no longer current"));
			};
			try {
				timer = this.#setTimeout(() => {
					timer = null;
					finish(this.#inspectFailure("timeout", `the pi-subagents inspect command did not answer within ${this.#inspectTimeoutMs}ms`));
				}, this.#inspectTimeoutMs);
				timer?.unref?.();
			} catch (error) {
				finish(this.#inspectFailure("unavailable", `the inspect deadline could not be scheduled: ${errorText(error)}`));
				return;
			}
			let answer;
			try {
				answer = this.#inspectRunner(commandText, requestId, {
					timeoutMs: this.#inspectTimeoutMs,
					id,
					childId,
					lines,
					...(controller ? { signal: controller.signal } : {}),
				});
			} catch (error) {
				finish(this.#inspectFailure("failed", `the pi-subagents inspect command failed: ${errorText(error)}`));
				return;
			}
			Promise.resolve(answer).then(
				(value) => {
					// The command answered, so its own deadline no longer applies: the fallback below
					// runs under the RPC deadline, and one inspection still has exactly one bound.
					const result = this.#interpretInspectAnswer(value, requestId);
					clearDeadline();
					if (result.ok || result.code !== "not_found" || childId !== undefined) {
						finish(result);
						return;
					}
					// The inspect command serves async runs only and refuses a blocking (foreground)
					// delegation with exactly this code, while pi-subagents still answers that run's
					// transcript through its status action. The refusal gets one bounded second look.
					this.#transcriptFallback(id, lines).then(
						(fallback) => finish(fallback.ok === true ? fallback : preferInspectFailure(result, fallback)),
						() => finish(result),
					);
				},
				(error) => {
					clearDeadline();
					finish(this.#inspectFailure("failed", `the pi-subagents inspect command failed: ${errorText(error)}`));
				},
			);
		});
	}

	/**
	 * Read one run's transcript through the extension's `status` action — the shape
	 * pi-subagents offers for blocking (foreground) delegations, which its structured inspect
	 * command refuses by design. A live foreground run answers with its running child's event
	 * tail, a remembered one with its child state, acceptance and result tail; both are text.
	 *
	 * The text passes through the same bound and redaction as `detail()`, so this fallback can
	 * never widen what reaches the browser, and it accepts no id that the caller had not already
	 * checked against this generation's allowlist.
	 *
	 * @param {string} id an id already accepted by this generation's allowlist
	 * @param {number|undefined} lines the validated inspection line count
	 */
	#transcriptFallback(id, lines) {
		const bound = lines ?? SUBAGENT_DETAIL_LINES;
		return this.#requestRpc("status", { id, view: "transcript", lines: bound }).then((reply) => {
			if (!reply.ok) return reply;
			if (!isRecord(reply.data)) {
				return failure("invalid_reply", 502, "invalid_reply", "pi-subagents returned no status data for this run");
			}
			const text = detailText(reply.data.text);
			if (!text) {
				return failure("not_found", 404, "not_found", "pi-subagents returned no transcript for this run");
			}
			return {
				ok: true,
				generation: this.#generation,
				inspect: { kind: "transcript", runId: id, lines: bound, text },
			};
		});
	}

	/** Bounded failure for one structured inspection, always with a distinct code. */
	#inspectFailure(kind, message) {
		const [status, code] = SUBAGENT_INSPECT_FAILURES[kind] ?? SUBAGENT_INSPECT_FAILURES.failed;
		return failure(code, status, code, message);
	}

	/** Validate constraints pi-subagents enforces once more on our side. */
	#newInspectRequestId() {
		let generated;
		try {
			generated = String(this.#randomUUID());
		} catch {
			return null;
		}
		const requestId = generated.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
		return isValidInspectRequestId(requestId) ? requestId : null;
	}

	/** Return whether the current snapshot of one retained run contains this child node id. */
	#hasChildId(runId, childId) {
		const run = this.#asyncSnapshot.runs.find((candidate) => candidate.id === runId);
		if (!run) return false;
		const stack = Array.isArray(run.children) ? [...run.children] : [];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!isRecord(node)) continue;
			if (node.id === childId) return true;
			if (Array.isArray(node.children)) stack.push(...node.children);
		}
		return false;
	}

	/**
	 * Turn whatever the inspect runner answered with into one result. Accepted shapes:
	 * a captured widget line (string), `{ ok: true, line }`, `{ ok: false, reason }`, or the
	 * literal `false` a `session.prompt()` returns when the command is not registered.
	 */
	#interpretInspectAnswer(answer, requestId) {
		if (answer === false) {
			return this.#inspectFailure("unavailable", "the pi-subagents inspect command is not registered in this session, so it was never sent as a prompt");
		}
		let line;
		if (typeof answer === "string") {
			line = answer;
		} else if (isRecord(answer)) {
			if (answer.ok === false) {
				const reason = safeCode(answer.reason, { fallback: "no_reply", maxChars: 64 });
				if (reason === "not_registered") {
					return this.#inspectFailure("unavailable", "the pi-subagents inspect command is not registered in this session, so it was never sent as a prompt");
				}
				if (reason === "commands_unavailable") {
					return this.#inspectFailure("commandsUnavailable", "the session does not expose its command list, so the inspect command was refused instead of being sent as a model prompt");
				}
				if (reason === "no_capture" || reason === "no_session") {
					return this.#inspectFailure("unavailable", "this host cannot run the pi-subagents inspect command against the bound session");
				}
				if (reason === "timeout") {
					return this.#inspectFailure("timeout", `the pi-subagents inspect command did not answer within ${this.#inspectTimeoutMs}ms`);
				}
				if (reason === "no_payload") {
					return this.#inspectFailure("failed", "the pi-subagents inspect command answered without a structured reply for this request");
				}
				return this.#inspectFailure("failed", `the pi-subagents inspect command did not return a usable reply (${reason})`);
			}
			line = typeof answer.line === "string" ? answer.line : undefined;
		}
		if (line === undefined) {
			return this.#inspectFailure("failed", "the pi-subagents inspect command returned no structured reply");
		}
		const parsed = parseInspectWidgetLine(line);
		if (!parsed.ok) {
			return this.#inspectFailure("failed", `the pi-subagents inspect reply was rejected (${parsed.reason})`);
		}
		const projected = projectInspectReply(parsed.reply, { requestId });
		if (projected.ok) {
			return { ok: true, generation: this.#generation, inspect: projected.inspect };
		}
		if (projected.reason === "extension_error") {
			const status = INSPECT_ERROR_STATUS[projected.error.code];
			return status === undefined
				? failure("inspect_failed", 502, "inspect_failed", projected.error.message)
				: failure(projected.error.code, status, projected.error.code, projected.error.message);
		}
		return this.#inspectFailure("failed", `the pi-subagents inspect reply was rejected (${projected.reason})`);
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
		const inspectAbort = this.#inspectAbort;
		this.#inspectAbort = null;
		try { inspectAbort?.abort(); } catch { /* best effort */ }
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

/**
 * Build the exact command line for one structured inspection. Every token is validated
 * before it is appended, so no id or count can smuggle an extra argument or flag into the
 * extension's argument parser.
 */
export function subagentInspectCommand(requestId, asyncId, childId, lines) {
	const parts = [`/${INSPECT_COMMAND_NAME}`, requestId, asyncId];
	if (childId !== undefined) parts.push(childId);
	if (lines !== undefined) parts.push("--lines", String(lines));
	return parts.join(" ");
}

export { detailText, projectAsyncSnapshot, projectFleet, projectResultSummary };
