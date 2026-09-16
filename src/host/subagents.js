/**
 * Read-only pi-subagents status for the SDK host (work group 4).
 *
 * ## Public channel: the host owns the extension event bus
 *
 * pi-subagents registers its read-only RPC owner through the *shared extension event
 * bus*: while its extension factory runs it calls
 * `pi.events.on("subagents:rpc:v1:request", …)`, and the SDK gives every extension the
 * single `EventBus` instance its resource loader owns (`DefaultResourceLoader({ eventBus })`
 * → `pi.events`, `dist/core/extensions/loader.js`).
 *
 * A session exposes no public path to that bus: `session.extensionRunner` is public, but
 * its `runtime` has no event-bus member (only `trackEventBusSubscription`), and
 * `AgentSession` carries no bus itself. The remaining public route is to *own* the bus:
 * create it with the SDK's own `sdk.createEventBus()` and hand it to the SDK's own
 * `sdk.DefaultResourceLoader`. That loader keeps Pi's default discovery — same `cwd`, same
 * `sdk.getAgentDir()`, same `SettingsManager.create(cwd, agentDir)` that
 * `createAgentSession()` would have used — so the user's extensions, skills, prompts and
 * project context load exactly as before; only the bus identity changes.
 *
 * Checked against Pi 0.85.1: `createAgentSession({ cwd, sessionManager })` and
 * `createAgentSession({ cwd, sessionManager, resourceLoader })` with the owned bus resolved
 * the *same* 11 user extension paths with zero load errors, and the real pi-subagents
 * extension answered our ping/status RPC over the owned bus.
 *
 * When the installed SDK does not export that public surface, this module does not guess a
 * private seam: `openSubagentsChannel()` returns an explicit reason, `src/host/host.js`
 * leaves the adapter unattached, `/api/state` carries no `subagents` section and the page
 * keeps showing the panel as Unavailable.
 *
 * ## Read-only capability
 *
 * `HostSubagentsBridge` is a thin, generation-scoped wrapper around the already verified
 * shared consumer (`src/core/subagents-rpc.js`, moved verbatim out of the removed
 * `src/adapter/` route) and inherits its semantics:
 *
 * - list: the public fleet projection plus the separate async-run snapshot;
 * - details: on demand only, for an async run id that the *current* successful status
 *   response returned (an opaque fleet display key is never a run id and can never target
 *   a request);
 * - refresh: explicit, status only;
 * - bounded DTOs (entry/run/child/result limits, character limits, public `updatedAt`
 *   timestamps) with best-effort secret redaction that keeps ordinary path text;
 * - distinct `ready-empty`, `rpc unavailable`/`timeout`/`error` states and no invented data.
 *
 * It sends only `ping` and `status` RPC requests. It has no spawn/manage/schedule/steer/
 * stop/interrupt/resume path and never starts a subagent, so the panel cannot change
 * session state.
 */

import { SubagentsBridge } from "../core/subagents-rpc.js";

/**
 * Default coalescing window for the public async-run lifecycle hints. A burst (for example
 * several children reporting status in the same instant) becomes one status refresh.
 */
export const HOST_SUBAGENTS_EVENT_DEBOUNCE_MS = 100;

const REFRESH_BODY_KEYS = new Set(["generation"]);
const DETAIL_BODY_KEYS = new Set(["generation", "id"]);

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure(status, code, message) {
	return { ok: false, status, code, message };
}

/**
 * Report the public SDK exports the shared extension event bus needs and the SDK lacks:
 * `createEventBus`, `DefaultResourceLoader`, `SettingsManager.create` and `getAgentDir`.
 */
export function missingSubagentsChannelExports(sdk) {
	const missing = [];
	if (typeof sdk?.createEventBus !== "function") missing.push("createEventBus");
	if (typeof sdk?.DefaultResourceLoader !== "function") missing.push("DefaultResourceLoader");
	if (typeof sdk?.SettingsManager?.create !== "function") missing.push("SettingsManager.create");
	if (typeof sdk?.getAgentDir !== "function") missing.push("getAgentDir");
	return missing;
}

/**
 * Open the read-only subagents channel: the extension event bus every loaded extension
 * shares, plus the resource loader that must be handed to `createAgentSession()` so the
 * session uses that same bus. Never throws; an unavailable channel carries an explicit
 * reason instead of a fallback seam.
 *
 * The returned `resourceLoader` must be reloaded by the caller before `createAgentSession()`
 * (the SDK skips its own reload for a caller-provided loader), exactly like the default
 * loader the SDK would have built.
 *
 * @param {object} options
 * @param {object} options.sdk public SDK namespace
 * @param {string} options.cwd session working directory used for resource discovery
 * @param {(message: string) => void} [options.logger]
 * @returns {{ available: boolean, eventBus: object | null, resourceLoader: object | null, agentDir: string | null, reason: string | null }}
 */
/** Upper bound for extra extension paths from `PI_GUI_EXTRA_EXTENSIONS`. */
export const MAX_EXTRA_EXTENSION_PATHS = 16;

export function openSubagentsChannel({ sdk, cwd, logger = () => {}, extraExtensionPaths = [] } = {}) {
	const missing = missingSubagentsChannelExports(sdk);
	if (missing.length > 0) {
		return {
			available: false,
			eventBus: null,
			resourceLoader: null,
			agentDir: null,
			reason:
				`the installed host SDK does not expose the public extensions a shared extension event bus needs (${missing.join(", ")}), ` +
				"so the read-only pi-subagents panel cannot be attached",
		};
	}
	try {
		const eventBus = sdk.createEventBus();
		if (!eventBus || typeof eventBus.on !== "function" || typeof eventBus.emit !== "function") {
			return {
				available: false,
				eventBus: null,
				resourceLoader: null,
				agentDir: null,
				reason: "the installed host SDK createEventBus() did not return an event bus with on()/emit()",
			};
		}
		const agentDir = sdk.getAgentDir();
		if (typeof agentDir !== "string" || agentDir.length === 0) {
			return {
				available: false,
				eventBus: null,
				resourceLoader: null,
				agentDir: null,
				reason: "the installed host SDK getAgentDir() did not return the agent directory the default resource loader uses",
			};
		}
		const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
		// Extra extensions are appended to Pi's default discovery (never replace it).
		const extras = Array.isArray(extraExtensionPaths)
			? extraExtensionPaths.filter((entry) => typeof entry === "string" && entry.trim().length > 0).slice(0, MAX_EXTRA_EXTENSION_PATHS)
			: [];
		const resourceLoader = new sdk.DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			eventBus,
			...(extras.length > 0 ? { additionalExtensionPaths: extras } : {}),
		});
		return { available: true, eventBus, resourceLoader, agentDir, reason: null, extraExtensionPaths: extras };
	} catch (error) {
		const reason = `could not create the shared extension event bus: ${errorMessage(error)}`;
		try {
			logger(`browser subagents: ${reason}`);
		} catch {
			// Logging is best effort while the host is starting.
		}
		return { available: false, eventBus: null, resourceLoader: null, agentDir: null, reason };
	}
}

/**
 * Generation-scoped, read-only subagents adapter for one SDK session.
 *
 * The initial `ping → status` bind starts on construction (like the underlying bridge) and
 * is deliberately not awaited by the host: `/api/state` shows `loading` and then the
 * honest ready/empty/unavailable state, so a missing or slow RPC owner never delays
 * startup. `bind()` is available for tests and callers that want to await the first answer.
 */
export class HostSubagentsBridge {
	#bridge;
	#logger;
	#active = true;

	constructor({
		eventBus,
		generation,
		logger = () => {},
		eventDebounceMs = HOST_SUBAGENTS_EVENT_DEBOUNCE_MS,
		timeoutMs = undefined,
		randomUUID = undefined,
		setTimeout: setTimer = undefined,
		clearTimeout: clearTimer = undefined,
	} = {}) {
		if (!eventBus || typeof eventBus.on !== "function" || typeof eventBus.emit !== "function") {
			throw new Error("HostSubagentsBridge requires the shared extension event bus");
		}
		if (!Number.isInteger(generation) || generation < 1) {
			throw new Error("HostSubagentsBridge requires a positive integer binding generation");
		}
		this.#logger = logger;
		const options = { events: eventBus, generation, logger };
		if (Number.isFinite(eventDebounceMs) && eventDebounceMs >= 0) {
			options.eventDebounceMs = eventDebounceMs;
		}
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			options.timeoutMs = timeoutMs;
		}
		for (const [key, value] of [["randomUUID", randomUUID], ["setTimeout", setTimer], ["clearTimeout", clearTimer]]) {
			if (typeof value === "function") {
				options[key] = value;
			}
		}
		this.#bridge = new SubagentsBridge(options);
	}

	get generation() {
		return this.#bridge.generation;
	}

	get active() {
		return this.#active;
	}

	/** Promise for the initial ping → untargeted status bind; it never rejects. */
	bind() {
		return this.#bridge.bind();
	}

	/** Bounded, defensive snapshot for `/api/state`. */
	snapshot() {
		return this.#bridge.snapshot();
	}

	/** Read one allowlisted async run transcript; never accepts a fleet key or another body field. */
	details(expectedGeneration, body = {}) {
		if (!this.#active) {
			return Promise.resolve(failure(409, "stale_generation", "the browser session generation is no longer current"));
		}
		if (!isRecord(body) || Object.keys(body).some((key) => !DETAIL_BODY_KEYS.has(key))) {
			return Promise.resolve(failure(400, "invalid_body", "subagent details only accept the current generation and async run id"));
		}
		return this.#bridge.detail(expectedGeneration, body);
	}

	/**
	 * Explicit status-only refresh. A successful refresh returns the new snapshot; an
	 * unavailable owner is reported as a failure *and* with the snapshot, so the page can
	 * still render the honest state instead of keeping a stale list.
	 */
	refresh(expectedGeneration, body = {}) {
		if (!this.#active || expectedGeneration !== this.generation) {
			return Promise.resolve(failure(409, "stale_generation", "the browser session generation is no longer current"));
		}
		if (!isRecord(body) || Object.keys(body).some((key) => !REFRESH_BODY_KEYS.has(key))) {
			return Promise.resolve(failure(400, "invalid_body", "subagent refresh only accepts the current generation"));
		}
		if (body.generation !== expectedGeneration) {
			return Promise.resolve(failure(409, "stale_generation", "the browser session generation is no longer current"));
		}
		return this.#bridge.refresh().then((snapshot) => {
			if (!this.#active) {
				return failure(409, "stale_generation", "the browser session generation is no longer current");
			}
			if (snapshot.available) {
				return { ok: true, generation: expectedGeneration, subagents: snapshot };
			}
			const error = snapshot.error ?? {
				kind: "unavailable",
				code: "rpc_unavailable",
				message: "pi-subagents in-process RPC is unavailable",
			};
			const status = error.code === "timeout" ? 504 : error.kind === "rpc_error" || error.kind === "invalid_reply" ? 502 : 503;
			return { ok: false, status, code: error.code, message: error.message, subagents: snapshot };
		});
	}

	/** Release every bus subscription, timer and pending RPC request; idempotent. */
	dispose() {
		if (!this.#active) {
			return;
		}
		this.#active = false;
		try {
			this.#bridge.dispose();
		} catch (error) {
			try {
				this.#logger(`browser subagents: could not release the read-only bridge: ${errorMessage(error)}`);
			} catch {
				// best effort during shutdown
			}
		}
	}
}
