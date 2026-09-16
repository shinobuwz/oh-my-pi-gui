/**
 * Read-only session status for the SDK host (work group 3).
 *
 * The browser contract is unchanged from the legacy extension adapter
 * (`available/cwd/git/tokens/contextUsage/revision`), so `src/browser/app.js` renders the
 * status panel without modification, and the implementation deliberately *reuses* the
 * previously verified shared status bridge (`src/core/git-status.js`, moved verbatim out of
 * the removed `src/adapter/` route: same bounded Git argv, `shell: false`, timeout/maxBuffer,
 * reason-code-only failures, active-branch usage aggregation and disposal rules) over a
 * read-only view of the public `AgentSession`:
 *
 * - cwd:            `session.sessionManager.getCwd()` (falling back to the host's own session
 *                   cwd when the public reader is missing, never to a guessed path)
 * - token totals:   `session.sessionManager.getBranch()` (then `getEntries()`)
 * - context usage:  `session.getContextUsage()` (+ `session.model.contextWindow`)
 * - Git branch:     one fixed, read-only `git` query per throttle window, refreshed after the
 *                   session events that can change the branch
 *
 * Nothing but bounded display values crosses this boundary: session content, prompt text,
 * provider configuration, credentials and costs never leave the adapter, and a failing Git
 * query is reported as a reason code instead of its command output. Missing values stay
 * explicitly unknown (`null`) rather than being reported as zero. `dispose()` clears the
 * session reference, unsubscribes, ends the refresh timer and ignores late Git callbacks.
 */

import { StatusBridge } from "../core/git-status.js";

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Public session cwd: the session manager is authoritative; the host-known cwd is only used
 * when the installed shape no longer exposes a reader. A missing value stays `null`.
 */
export function readSessionCwd(session) {
	try {
		const manager = session?.sessionManager;
		const cwd = typeof manager?.getCwd === "function" ? manager.getCwd() : undefined;
		if (typeof cwd === "string" && cwd.length > 0) {
			return cwd;
		}
		const direct = session?.cwd;
		if (typeof direct === "string" && direct.length > 0) {
			return direct;
		}
	} catch {
		// A broken public reader is a missing value, not a reason to guess.
	}
	return null;
}

/** Generation-scoped, read-only status adapter for one SDK session. */
export class HostStatusBridge {
	#session;
	#bridge;
	#logger;
	#unsubscribe = null;
	#active = true;

	constructor({
		session,
		generation,
		fallbackCwd = null,
		logger = () => {},
		execFile = undefined,
		refreshThrottleMs = undefined,
	} = {}) {
		if (!session) {
			throw new Error("HostStatusBridge requires an AgentSession");
		}
		if (!Number.isInteger(generation) || generation < 1) {
			throw new Error("HostStatusBridge requires a positive integer binding generation");
		}
		this.#session = session;
		this.#logger = logger;

		// Read-only context view: every value is read from the session when the shared bridge
		// takes a snapshot, so a model or context-window change is never cached here.
		const owner = this;
		const source = {
			get cwd() {
				return readSessionCwd(owner.#session) ?? fallbackCwd;
			},
			get model() {
				try {
					return owner.#session?.model ?? null;
				} catch {
					return null;
				}
			},
			get sessionManager() {
				try {
					return owner.#session?.sessionManager ?? null;
				} catch {
					return null;
				}
			},
			getContextUsage() {
				try {
					return typeof owner.#session?.getContextUsage === "function" ? owner.#session.getContextUsage() : undefined;
				} catch {
					return undefined;
				}
			},
		};

		const options = { ctx: source, generation, logger };
		if (typeof execFile === "function") {
			options.execFile = execFile;
		}
		if (Number.isFinite(refreshThrottleMs) && refreshThrottleMs >= 0) {
			options.refreshThrottleMs = refreshThrottleMs;
		}
		this.#bridge = new StatusBridge(options);
		this.#subscribeSession();
	}

	get generation() {
		return this.#bridge.generation;
	}

	/** Whether this adapter still owns its session subscription. */
	get active() {
		return this.#active;
	}

	/** Handle one public `session.subscribe()` event. */
	handle(event) {
		if (!this.#active || !event || typeof event.type !== "string") {
			return;
		}
		// `agent_end` / `agent_settled` / `message_end` are names the shared bridge already
		// refreshes on (throttled, with a revision bump). `compaction_end` is session-only.
		this.#bridge.handle(event);
		if (event.type === "compaction_end") {
			void this.#bridge.refresh();
		}
	}

	snapshot() {
		return this.#bridge.snapshot();
	}

	/** Explicit bounded Git refresh; status values themselves stay read-only. */
	refresh() {
		return this.#bridge.refresh();
	}

	/** Unsubscribe and release the session/timer/child references of the shared bridge. */
	dispose() {
		if (!this.#active) {
			return;
		}
		this.#active = false;
		const unsubscribe = this.#unsubscribe;
		this.#unsubscribe = null;
		try {
			unsubscribe?.();
		} catch (error) {
			this.#logger(`browser status: could not unsubscribe from session events: ${errorMessage(error)}`);
		}
		this.#bridge.dispose();
		this.#session = null;
	}

	#subscribeSession() {
		try {
			const unsubscribe = this.#session.subscribe((event) => this.handle(event));
			if (typeof unsubscribe === "function") {
				this.#unsubscribe = unsubscribe;
			} else {
				this.#logger("browser status: session.subscribe() did not return an unsubscribe function; Git refreshes may continue after shutdown");
			}
		} catch (error) {
			this.#logger(`browser status: could not subscribe to session events: ${errorMessage(error)}`);
		}
	}
}
