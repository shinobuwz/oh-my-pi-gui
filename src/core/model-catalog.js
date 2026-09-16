/**
 * Shared pure model/thinking catalog helpers.
 *
 * Extracted verbatim from the removed private-seam adapter (`src/adapter/model-bridge.js`)
 * so the SDK host (`src/host/models.js`) keeps the exact same allowlist and sanitizing
 * semantics without a second implementation: the browser only ever receives display fields
 * (provider/id/name and useful capability numbers) plus a derived provider/id candidate key,
 * and every request is checked against the bounded public thinking level set.
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
export const MAX_IDENTIFIER_CHARS = 512;
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

export function safeThinking(value) {
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
