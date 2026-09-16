/**
 * Generation-scoped model and thinking controls for the current Pi session.
 *
 * The browser only receives safe model metadata and an opaque-to-the-browser
 * candidate key. The host model object is retained in this generation's adapter
 * and is the only value passed to Pi's public setModel() API.
 */

export const THINKING_LEVELS = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);
const MAX_IDENTIFIER_CHARS = 512;
const MAX_DISPLAY_CHARS = 512;

function validIdentifier(value) {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_CHARS ? value : null;
}

function displayText(value) {
	return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_DISPLAY_CHARS) : null;
}

function finitePositive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function safeThinking(value) {
	return typeof value === "string" && THINKING_LEVEL_SET.has(value) ? value : null;
}

/** Stable identity used by browser requests; the browser never supplies a model object. */
export function modelKey(model) {
	if (!model || typeof model !== "object") {
		return null;
	}
	const provider = validIdentifier(model.provider);
	const id = validIdentifier(model.id);
	return provider && id ? `${provider}/${id}` : null;
}

/** Copy only model fields useful for display; never copy provider/auth configuration. */
export function snapshotModel(model) {
	if (!model || typeof model !== "object") {
		return null;
	}
	const provider = validIdentifier(model.provider);
	const id = validIdentifier(model.id);
	if (!provider || !id) {
		return null;
	}
	const snapshot = { provider, id };
	const name = displayText(model.name);
	if (name) {
		snapshot.name = name;
	}
	if (typeof model.reasoning === "boolean") {
		snapshot.reasoning = model.reasoning;
	}
	const contextWindow = finitePositive(model.contextWindow);
	if (contextWindow !== null) {
		snapshot.contextWindow = contextWindow;
	}
	const maxTokens = finitePositive(model.maxTokens);
	if (maxTokens !== null) {
		snapshot.maxTokens = maxTokens;
	}
	return snapshot;
}

function failure(status, code, message, extra = {}) {
	return { ok: false, status, code, message, ...extra };
}

function readError(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Controls for one live extension context. BrowserBridge disposes this object
 * before a reload can expose a new context, so old ctx/model references are not
 * reachable through the process-owned registry.
 */
export class ModelBridge {
	#pi;
	#ctx;
	#generation;
	#logger;
	#active = true;
	#revision = 0;
	#lastError = null;

	constructor({ pi, ctx, generation, logger = () => {} }) {
		if (!pi || typeof pi.setModel !== "function" || typeof pi.getThinkingLevel !== "function" || typeof pi.setThinkingLevel !== "function") {
			throw new Error("ModelBridge requires Pi's public model and thinking actions");
		}
		if (!ctx) {
			throw new Error("ModelBridge requires a current extension context");
		}
		this.#pi = pi;
		this.#ctx = ctx;
		this.#generation = generation;
		this.#logger = logger;
	}

	get generation() {
		return this.#generation;
	}

	/** Handle host-announced effective state changes. */
	handle(event, ctx = this.#ctx) {
		if (!this.#active || !event || typeof event.type !== "string") {
			return;
		}
		if (ctx) {
			this.#ctx = ctx;
		}
		if (event.type !== "model_select" && event.type !== "thinking_level_select") {
			return;
		}
		this.#lastError = null;
		this.#revision += 1;
	}

	/** Safe browser state and the current generation's candidate allowlist. */
	snapshot() {
		if (!this.#active || !this.#ctx) {
			return {
				available: false,
				model: null,
				thinkingLevel: null,
				thinkingLevels: [...THINKING_LEVELS],
				candidates: [],
				revision: this.#revision,
				lastError: "the current Pi session is no longer attached",
			};
		}
		const candidates = this.#buildCandidates();
		return {
			available: true,
			model: this.#currentModel(),
			thinkingLevel: this.#currentThinkingLevel(),
			thinkingLevels: [...THINKING_LEVELS],
			candidates: candidates.map((entry) => entry.public),
			revision: this.#revision,
			lastError: this.#lastError,
		};
	}

	/** Select only a candidate from the current generation's allowlist. */
	async selectModel(expectedGeneration, body = {}) {
		const checked = this.#checkRequest(expectedGeneration, body);
		if (checked) {
			return checked;
		}
		const keys = Object.keys(body);
		if (keys.some((key) => key !== "generation" && key !== "key")) {
			return failure(400, "invalid_body", "model requests only accept generation and an allowlisted candidate key");
		}
		if (typeof body.key !== "string" || body.key.length === 0 || body.key.length > MAX_IDENTIFIER_CHARS * 2 + 1) {
			return failure(400, "invalid_model_key", "model key must be a non-empty candidate key");
		}

		const candidate = this.#buildCandidates().find((entry) => entry.key === body.key);
		if (!candidate) {
			return failure(409, "model_not_allowed", "the requested model is not in the current session allowlist", {
				current: this.snapshot(),
			});
		}

		let result;
		try {
			result = await this.#pi.setModel(candidate.model);
		} catch (error) {
			this.#logger(`model change failed: ${readError(error)}`);
			this.#lastError = "model change failed; the current model remains active";
			this.#revision += 1;
			return failure(409, "model_change_failed", this.#lastError, { current: this.snapshot() });
		}
		if (!this.#active || !this.#ctx) {
			return failure(409, "stale_generation", "the browser session generation is no longer current");
		}
		if (result === false) {
			this.#lastError = "the requested model is not authenticated; the current model remains active";
			this.#revision += 1;
			return failure(409, "model_unavailable", this.#lastError, { current: this.snapshot() });
		}

		// A scoped candidate may pin a thinking level. Apply it through the public
		// session action, then read back the host's effective (possibly clamped) value.
		if (candidate.thinkingLevel) {
			try {
				this.#pi.setThinkingLevel(candidate.thinkingLevel);
			} catch (error) {
				this.#logger(`pinned thinking level failed after model selection: ${readError(error)}`);
				this.#lastError = "model selected, but its pinned thinking level could not be applied";
				this.#revision += 1;
				return failure(409, "thinking_change_failed", this.#lastError, { current: this.snapshot() });
			}
		}
		this.#lastError = null;
		this.#revision += 1;
		const controls = this.snapshot();
		return {
			ok: true,
			requestedKey: body.key,
			effectiveModel: controls.model,
			effectiveThinkingLevel: controls.thinkingLevel,
			controls,
		};
	}

	/** Set a bounded thinking choice and report the host's clamped effective value. */
	async setThinkingLevel(expectedGeneration, body = {}) {
		const checked = this.#checkRequest(expectedGeneration, body);
		if (checked) {
			return checked;
		}
		const keys = Object.keys(body);
		if (keys.some((key) => key !== "generation" && key !== "level")) {
			return failure(400, "invalid_body", "thinking requests only accept generation and an allowlisted level");
		}
		if (typeof body.level !== "string" || !THINKING_LEVEL_SET.has(body.level)) {
			return failure(400, "invalid_thinking_level", `thinking level must be one of ${THINKING_LEVELS.join(", ")}`);
		}
		try {
			this.#pi.setThinkingLevel(body.level);
		} catch (error) {
			this.#logger(`thinking level change failed: ${readError(error)}`);
			this.#lastError = "thinking level change failed; the current level remains active";
			this.#revision += 1;
			return failure(409, "thinking_change_failed", this.#lastError, { current: this.snapshot() });
		}
		if (!this.#active || !this.#ctx) {
			return failure(409, "stale_generation", "the browser session generation is no longer current");
		}
		this.#lastError = null;
		this.#revision += 1;
		const controls = this.snapshot();
		return {
			ok: true,
			requestedLevel: body.level,
			effectiveLevel: controls.thinkingLevel,
			clamped: controls.thinkingLevel !== body.level,
			controls,
		};
	}

	dispose() {
		this.#active = false;
		this.#pi = null;
		this.#ctx = null;
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
			return snapshotModel(this.#ctx?.model);
		} catch {
			return null;
		}
	}

	#currentThinkingLevel() {
		try {
			const level = safeThinking(this.#pi?.getThinkingLevel?.());
			if (level) {
				return level;
			}
		} catch {
			// Fall through to the context's read-only effective value.
		}
		try {
			return safeThinking(this.#ctx?.thinkingLevel);
		} catch {
			return null;
		}
	}

	/** Build a fresh allowlist; never trust a key from an older snapshot. */
	#buildCandidates() {
		let scoped;
		try {
			scoped = Array.isArray(this.#ctx?.scopedModels) ? this.#ctx.scopedModels : [];
		} catch (error) {
			this.#recordCandidateError(error);
			return [];
		}
		let entries = scoped;
		if (scoped.length === 0) {
			try {
				entries = this.#ctx?.modelRegistry?.getAvailable?.() ?? [];
			} catch (error) {
				this.#recordCandidateError(error);
				return [];
			}
		}
		if (!Array.isArray(entries)) {
			this.#recordCandidateError(new Error("model registry returned a non-array candidate list"));
			return [];
		}

		const seen = new Set();
		const candidates = [];
		for (const entry of entries) {
			const model = scoped.length === 0 ? entry : entry?.model;
			let key;
			let publicModel;
			try {
				key = modelKey(model);
				publicModel = snapshotModel(model);
			} catch {
				continue;
			}
			if (!key || !publicModel || seen.has(key)) {
				continue;
			}
			seen.add(key);
			let thinkingLevel = null;
			try {
				thinkingLevel = scoped.length > 0 ? safeThinking(entry?.thinkingLevel) : null;
			} catch {
				thinkingLevel = null;
			}
			const publicEntry = { key, ...publicModel };
			if (thinkingLevel) {
				publicEntry.thinkingLevel = thinkingLevel;
			}
			candidates.push({ key, model, thinkingLevel, public: publicEntry });
		}
		return candidates;
	}

	#recordCandidateError(error) {
		const message = "model candidates are temporarily unavailable";
		if (this.#lastError !== message) {
			this.#logger(`${message}: ${readError(error)}`);
		}
		this.#lastError = message;
	}
}

export { safeThinking };
