/**
 * Shared, pure redaction/truncation primitives for the read-only pi-subagents
 * projections.
 *
 * The functions were moved verbatim out of `src/core/subagents-rpc.js` (their only
 * caller until now) so the status/transcript projection and the structured inspect
 * projection redact credential-shaped text with one implementation instead of two
 * copies. Semantics are unchanged:
 *
 * - secrets: `Bearer …` tokens and `key/token/secret/password/…` assignments;
 * - sensitive path *fields*: `"sessionFile": "…"`, `cwd=…` and friends, which name a
 *   host location rather than ordinary conversation text;
 * - `safeText(..., { redactPaths: true })` additionally omits absolute host paths, the
 *   stricter rule used for identifiers, labels and error messages;
 * - `safeCode` normalizes a machine code into `[A-Za-z0-9_.-]`.
 */

export const BEARER_SECRET = /\bBearer\s+[^\s"'`<>,;)}\]]+/gi;
export const SECRET_ASSIGNMENT = /(\b(?:api[-_]?key|access[-_]?key|authorization|credential|private[-_]?key|refresh[-_]?token|key|token|secret|password)\b["']?\s*[:=]\s*)(?:(['"])[^'"\r\n]*\2|([^\s,;}\]\)]+))/gi;
export const PATH_LINE = /^\s*(?:async(?:Dir| directory)?|session(?:File| path)?|transcript(?:Path| path)?|output(?:File| path)?|saved output(?: path)?|cwd|working directory|artifact(?: path)?|events?|logs?|result(?: path)?|file|directory|path)\s*:/i;
export const SENSITIVE_PATH_FIELD = /("?(?:asyncDir|sessionFile|transcriptPath|artifactPath|outputFile|eventsPath|logPath|resultPath|cwd)"?\s*[:=]\s*)"?[^,}\r\n]+"?/gi;
export const PATH_TOKEN = /(?:[A-Za-z]:[\\/][^\s"'`<>]+|\\\\[^\s"'`<>]+|(?:^|[\s([{"'])\/(?:Users|home|tmp|var|private|workspace|workspaces|agent|async-subagent-runs)[^\s"'`<>]*)/gi;

export function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function truncate(value, maxChars) {
	if (value.length <= maxChars) return value;
	if (maxChars <= 1) return value.slice(0, Math.max(0, maxChars));
	return `${value.slice(0, maxChars - 1)}…`;
}

/** Replace every control byte, including line breaks, with a space. */
export function stripControls(value) {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * Keep line boundaries so sensitive artifact/session lines can be dropped as whole
 * records; all other control bytes become harmless spaces.
 */
export function stripDetailControls(value) {
	return value.replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}

export function redactSecretText(value) {
	return value
		.replace(BEARER_SECRET, "Bearer [redacted]")
		.replace(SECRET_ASSIGNMENT, (_match, prefix, quote) => `${prefix}${quote ? `${quote}[redacted]${quote}` : "[redacted]"}`);
}

export function redactPathTokens(value) {
	return value.replace(PATH_TOKEN, "[path omitted]");
}

/** Omit the sensitive path fields (`"sessionFile": "…"`) while keeping other text. */
export function redactSensitivePathFields(value) {
	return value.replace(SENSITIVE_PATH_FIELD, "$1[path omitted]");
}

/**
 * Bound one free-text projection: control bytes, credential-shaped text and (by
 * default) absolute host paths are removed before the value is trimmed and truncated.
 * `undefined` means "no usable text", never an empty string.
 */
export function safeText(value, maxChars, { redactPaths = true } = {}) {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const normalized = stripControls(value);
	const redacted = redactPaths ? redactPathTokens(normalized) : normalized;
	const trimmed = redacted.trim();
	return trimmed ? truncate(trimmed, maxChars) : undefined;
}

/** Normalize a machine-readable code without letting an extension inject characters. */
export function safeCode(value, { fallback = "rpc_error", maxChars = 96 } = {}) {
	if (typeof value !== "string" && typeof value !== "number") return fallback;
	const code = String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
	return truncate(code || fallback, maxChars);
}
