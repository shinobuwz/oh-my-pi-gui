/**
 * Browser model and thinking controls for the SDK host session (work group 3).
 *
 * Data source (public `AgentSession` members only):
 * - current model:  `session.model`
 * - current level:  `session.thinkingLevel`
 * - candidates:     `session.scopedModels` when non-empty, otherwise
 *                   `session.modelRuntime.getAvailableSnapshot()` (the sync snapshot of the
 *                   same model runtime that resolves the session's model/auth)
 * - levels:         `session.getAvailableThinkingLevels()`
 * - actions:        `session.setModel(model)` / `session.setThinkingLevel(level)`
 *
 * The browser contract is unchanged from the legacy extension adapter: the same
 * `available/model/thinkingLevel/thinkingLevels/candidates/revision/lastError` snapshot and
 * the same `/api/model` + `/api/thinking` responses, so `src/browser/app.js` renders the
 * panel without modification.
 *
 * Safety boundary: the browser only ever receives display fields (provider/id/name and useful
 * capability numbers) plus a derived `provider/id` candidate key. The host model object the
 * key maps to stays in this adapter and is the only value passed to the public `setModel()`
 * action — provider configuration, base URLs, headers and credentials never cross the
 * boundary. The browser can only submit a key from the allowlist built for the *current*
 * snapshot, so a stale or invented key is refused before any host call. No `persist` option is
 * ever passed to either action, so Pi's global model/thinking defaults are not written.
 *
 * Failure reporting is explicit: the SDK throws when a model cannot be activated (for example
 * without a usable API key) and `setThinkingLevel()` clamps to what the model supports. The
 * response always reports the host's actual effective model/level and says that the previous
 * state remains active on failure; the thrown provider message is only logged on the host.
 */

import { MAX_IDENTIFIER_CHARS, THINKING_LEVELS, modelKey, safeThinking, snapshotModel } from "../core/model-catalog.js";

/**
 * `provider` and `id` are each bounded to `MAX_IDENTIFIER_CHARS` characters by `modelKey()`,
 * so a candidate key can never exceed 2 * MAX_IDENTIFIER_CHARS + 1 characters.
 */
const MAX_CANDIDATE_KEY_CHARS = MAX_IDENTIFIER_CHARS * 2 + 1;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

function failure(status, code, message, extra = {}) {
	return { ok: false, status, code, message, ...extra };
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Generation-scoped model/thinking control for one SDK session. */
export class HostModelBridge {
	#session;
	#generation;
	#logger;
	#active = true;
	#revision = 0;
	#lastError = null;

	constructor({ session, generation, logger = () => {} } = {}) {
		if (!session || typeof session.setModel !== "function" || typeof session.setThinkingLevel !== "function") {
			throw new Error("HostModelBridge requires an AgentSession with setModel() and setThinkingLevel()");
		}
		if (!Number.isInteger(generation) || generation < 1) {
			throw new Error("HostModelBridge requires a positive integer binding generation");
		}
		this.#session = session;
		this.#generation = generation;
		this.#logger = logger;
	}

	get generation() {
		return this.#generation;
	}

	/** Whether this adapter still owns the session handle. */
	get active() {
		return this.#active;
	}

	/** Live browser state plus the candidate allowlist of the current session state. */
	snapshot() {
		if (!this.#active) {
			return {
				available: false,
				model: null,
				thinkingLevel: null,
				thinkingLevels: [...THINKING_LEVELS],
				candidates: [],
				revision: this.#revision,
				lastError: "the browser model controls are no longer attached to the session",
			};
		}
		return {
			available: true,
			model: this.#currentModel(),
			thinkingLevel: this.#currentThinkingLevel(),
			thinkingLevels: this.#availableThinkingLevels(),
			candidates: this.#buildCandidates().map((candidate) => candidate.public),
			revision: this.#revision,
			lastError: this.#lastError,
		};
	}

	/** Select only a candidate key built from the current session state. */
	async selectModel(expectedGeneration, body = {}) {
		const checked = this.#checkRequest(expectedGeneration, body);
		if (checked) {
			return checked;
		}
		const keys = Object.keys(body);
		if (keys.some((key) => key !== "generation" && key !== "key")) {
			return failure(400, "invalid_body", "model requests only accept generation and an allowlisted candidate key");
		}
		if (typeof body.key !== "string" || body.key.length === 0 || body.key.length > MAX_CANDIDATE_KEY_CHARS) {
			return failure(400, "invalid_model_key", "model key must be a non-empty candidate key");
		}

		const candidate = this.#buildCandidates().find((entry) => entry.key === body.key);
		if (!candidate) {
			return failure(409, "model_not_allowed", "the requested model is not in the current session allowlist", {
				current: this.snapshot(),
			});
		}

		let result = true;
		try {
			// No options on purpose: the change is session-only and must not rewrite defaults.
			result = await this.#session.setModel(candidate.model);
		} catch (error) {
			// The SDK throws for a missing API key or an unsupported model; that message can
			// name the provider, so it stays on the host and the browser gets the fixed text.
			this.#logger(`browser model: model change failed: ${errorMessage(error)}`);
			this.#lastError = "the requested model is not authenticated or unavailable; the current model remains active";
			this.#touch();
			return failure(409, "model_change_failed", this.#lastError, { current: this.snapshot() });
		}
		if (!this.#active) {
			return failure(409, "stale_generation", "the browser session generation is no longer current");
		}
		if (result === false) {
			// Defensive: a future session shape may report an unusable model as a value instead
			// of throwing. The current model is read back either way.
			this.#lastError = "the requested model is not authenticated; the current model remains active";
			this.#touch();
			return failure(409, "model_unavailable", this.#lastError, { current: this.snapshot() });
		}

		// A scoped candidate may pin a thinking level. Apply it through the public session
		// action, then read back the host's effective (possibly clamped) value.
		if (candidate.thinkingLevel) {
			try {
				await this.#session.setThinkingLevel(candidate.thinkingLevel);
			} catch (error) {
				this.#logger(`browser model: pinned thinking level failed after model selection: ${errorMessage(error)}`);
				this.#lastError = "model selected, but its pinned thinking level could not be applied";
				this.#touch();
				return failure(409, "thinking_change_failed", this.#lastError, { current: this.snapshot() });
			}
		}
		this.#lastError = null;
		this.#touch();
		const controls = this.snapshot();
		return {
			ok: true,
			requestedKey: body.key,
			effectiveModel: controls.model,
			effectiveThinkingLevel: controls.thinkingLevel,
			controls,
		};
	}

	/** Set a bounded thinking level and report the host's effective (clamped) value. */
	async setThinkingLevel(expectedGeneration, body = {}) {
		const checked = this.#checkRequest(expectedGeneration, body);
		if (checked) {
			return checked;
		}
		const keys = Object.keys(body);
		if (keys.some((key) => key !== "generation" && key !== "level")) {
			return failure(400, "invalid_body", "thinking requests only accept generation and an allowlisted level");
		}
		if (typeof body.level !== "string" || !safeThinking(body.level)) {
			return failure(400, "invalid_thinking_level", `thinking level must be one of ${THINKING_LEVELS.join(", ")}`);
		}

		try {
			// No options on purpose: the change is session-only and must not rewrite defaults.
			await this.#session.setThinkingLevel(body.level);
		} catch (error) {
			this.#logger(`browser model: thinking level change failed: ${errorMessage(error)}`);
			this.#lastError = "thinking level change failed; the current level remains active";
			this.#touch();
			return failure(409, "thinking_change_failed", this.#lastError, { current: this.snapshot() });
		}
		if (!this.#active) {
			return failure(409, "stale_generation", "the browser session generation is no longer current");
		}
		this.#lastError = null;
		this.#touch();
		const controls = this.snapshot();
		return {
			ok: true,
			requestedLevel: body.level,
			effectiveLevel: controls.thinkingLevel,
			clamped: controls.thinkingLevel !== body.level,
			controls,
		};
	}

	/** Drop the session reference; a later call for this generation is refused as stale. */
	dispose() {
		this.#active = false;
		this.#session = null;
		this.#lastError = null;
	}

	#checkRequest(expectedGeneration, body) {
		if (!this.#active || expectedGeneration !== this.#generation) {
			return failure(409, "stale_generation", "the browser session generation is no longer current");
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return failure(400, "invalid_body", "body must be a JSON object");
		}
		if (body.generation !== this.#generation) {
			return failure(409, "stale_generation", "the browser session generation is no longer current");
		}
		return null;
	}

	#currentModel() {
		try {
			return snapshotModel(this.#session?.model);
		} catch {
			return null;
		}
	}

	#currentThinkingLevel() {
		try {
			return safeThinking(this.#session?.thinkingLevel);
		} catch {
			return null;
		}
	}

	/**
	 * Levels the current model supports, bounded to Pi's public level set. When the session
	 * cannot describe them, the full public set stays selectable and the host still clamps to
	 * what the model supports — the same behaviour as the previous extension adapter.
	 */
	#availableThinkingLevels() {
		let reported = null;
		try {
			reported = typeof this.#session?.getAvailableThinkingLevels === "function"
				? this.#session.getAvailableThinkingLevels()
				: null;
		} catch {
			reported = null;
		}
		if (!Array.isArray(reported)) {
			return [...THINKING_LEVELS];
		}
		const levels = [];
		for (const value of reported) {
			const level = safeThinking(value);
			if (level && !levels.includes(level)) {
				levels.push(level);
			}
		}
		return levels.length > 0 ? levels : [...THINKING_LEVELS];
	}

	/** Build a fresh allowlist; a key from an older snapshot is never trusted. */
	#buildCandidates() {
		if (!this.#active) {
			return [];
		}
		let scoped = null;
		try {
			scoped = this.#session?.scopedModels;
		} catch (error) {
			this.#recordCandidateError(error);
			return [];
		}
		const scopedList = Array.isArray(scoped) ? scoped : [];
		if (scopedList.length > 0) {
			return this.#collectCandidates(scopedList.map((entry) => ({
				model: readProperty(entry, "model"),
				thinkingLevel: readProperty(entry, "thinkingLevel"),
			})));
		}

		let available = null;
		try {
			const runtime = this.#session?.modelRuntime;
			available = typeof runtime?.getAvailableSnapshot === "function" ? runtime.getAvailableSnapshot() : null;
		} catch (error) {
			this.#recordCandidateError(error);
			return [];
		}
		if (!Array.isArray(available)) {
			this.#recordCandidateError(new Error("the session model runtime did not return a candidate list"));
			return [];
		}
		return this.#collectCandidates(available.map((model) => ({ model, thinkingLevel: null })));
	}

	#collectCandidates(entries) {
		const seen = new Set();
		const candidates = [];
		for (const entry of entries) {
			let key = null;
			let publicModel = null;
			let pinned = null;
			try {
				key = modelKey(entry.model);
				publicModel = snapshotModel(entry.model);
				pinned = safeThinking(entry.thinkingLevel);
			} catch {
				continue;
			}
			if (!key || !publicModel || seen.has(key)) {
				continue;
			}
			seen.add(key);
			const publicEntry = { key, ...publicModel };
			if (pinned) {
				publicEntry.thinkingLevel = pinned;
			}
			candidates.push({ key, model: entry.model, thinkingLevel: pinned, public: publicEntry });
		}
		return candidates;
	}

	#recordCandidateError(error) {
		const message = "model candidates are temporarily unavailable";
		if (this.#lastError !== message) {
			this.#logger(`${message}: ${errorMessage(error)}`);
		}
		this.#lastError = message;
	}

	#touch() {
		if (this.#revision < MAX_REVISION) {
			this.#revision += 1;
		}
	}
}

/** Read one property defensively; a broken accessor is reported as a missing value. */
function readProperty(value, key) {
	try {
		return value?.[key];
	} catch {
		return undefined;
	}
}
