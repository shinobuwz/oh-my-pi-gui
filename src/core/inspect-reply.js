/**
 * Structured pi-subagents inspect reply: one pure parser + one bounded projection.
 *
 * pi-subagents answers a host inspection request through its own extend-surface: the
 * slash command `/subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]`
 * calls `ctx.ui.setWidget("subagent-inspect", ["PI_SUBAGENT_INSPECT_JSON:<json>"])` and
 * immediately retracts the widget again (emit-then-retract). This module turns that one
 * captured line into the bounded DTO the page receives:
 *
 * - the payload must carry `PI_SUBAGENT_INSPECT_JSON:`, the expected `kind`
 *   (`pi-subagents.inspect-reply`), the expected `version` and the host-generated
 *   `requestId`, so a stale or foreign reply can never be presented as data;
 * - malformed JSON, a different kind/version or a mismatched requestId are explicit
 *   rejections with a stable reason, never "best effort" parsing;
 * - the projection re-bounds everything the extension already bounds (≤200 messages,
 *   ≤1000 characters per message text, `task` ≤2000, `finalOutput` ≤8000) and keeps
 *   `truncated`, `status`, `label`, `childId` and `asyncId`;
 * - no path field survives: only the documented content fields are projected, and
 *   credential-shaped text plus sensitive path fields go through the shared redaction
 *   (`src/core/redaction.js`). Absolute host paths are omitted from identifiers, labels
 *   and error messages, and the extension's bounded error message is preserved.
 */

import {
	isRecord,
	redactSecretText,
	redactSensitivePathFields,
	safeCode,
	safeText,
	stripDetailControls,
	truncate,
} from "./redaction.js";

/** Dedicated widget key pi-subagents uses for its structured inspect reply. */
export const INSPECT_WIDGET_KEY = "subagent-inspect";
/** The slash command pi-subagents registers for host-side structured inspection. */
export const INSPECT_COMMAND_NAME = "subagents-inspect-rpc";
/** Payload prefix that marks one widget line as a structured inspect reply. */
export const INSPECT_PAYLOAD_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";
export const INSPECT_REPLY_KIND = "pi-subagents.inspect-reply";
export const INSPECT_REPLY_VERSION = 1;
/** Host-generated correlation id shape pi-subagents accepts. */
export const INSPECT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const INSPECT_LIMITS = Object.freeze({
	/** Message entries kept in the projection. */
	maxMessages: 200,
	/** Message lines pi-subagents reads by default when the request omits `--lines`. */
	defaultLines: 100,
	/** Message lines a request may ask for (same bound as the extension). */
	maxLines: 200,
	minLines: 1,
	maxMessageChars: 1000,
	maxRoleChars: 32,
	maxToolNameChars: 96,
	maxTaskChars: 2000,
	maxFinalOutputChars: 8000,
	maxLabelChars: 160,
	maxStatusChars: 96,
	maxRunIdChars: 256,
	maxErrorChars: 512,
});

/** Message kinds the structured view can render; anything else is dropped. */
export const INSPECT_MESSAGE_KINDS = Object.freeze(["text", "toolCall", "toolResult"]);

const MESSAGE_KIND_SET = new Set(INSPECT_MESSAGE_KINDS);

/** Return whether a string is a valid host-generated inspect request id. */
export function isValidInspectRequestId(value) {
	return typeof value === "string" && INSPECT_REQUEST_ID_PATTERN.test(value);
}

/** Accept only the line counts the extension itself accepts; `undefined` = not usable. */
export function boundedInspectLines(value) {
	if (!Number.isSafeInteger(value)) return undefined;
	if (value < INSPECT_LIMITS.minLines || value > INSPECT_LIMITS.maxLines) return undefined;
	return value;
}

/**
 * Parse one captured widget line.
 *
 * @param {unknown} value one widget line (or, defensively, the array the widget call carried)
 * @returns {{ ok: true, reply: object } | { ok: false, reason: string }}
 */
export function parseInspectWidgetLine(value) {
	const line = Array.isArray(value)
		? value.find((entry) => typeof entry === "string" && entry.includes(INSPECT_PAYLOAD_PREFIX))
		: value;
	if (typeof line !== "string" || line.length === 0) return { ok: false, reason: "empty_payload" };
	const prefixIndex = line.indexOf(INSPECT_PAYLOAD_PREFIX);
	if (prefixIndex === -1) return { ok: false, reason: "not_inspect_payload" };
	const raw = line.slice(prefixIndex + INSPECT_PAYLOAD_PREFIX.length);
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "malformed_json" };
	}
	if (!isRecord(parsed)) return { ok: false, reason: "malformed_reply" };
	if (parsed.kind !== INSPECT_REPLY_KIND) return { ok: false, reason: "unexpected_kind" };
	if (parsed.version !== INSPECT_REPLY_VERSION) return { ok: false, reason: "unsupported_version" };
	if (!isValidInspectRequestId(parsed.requestId)) return { ok: false, reason: "invalid_request_id" };
	return { ok: true, reply: parsed };
}

/**
 * Bound one long-form content value (task, final output, message text). Line breaks are
 * kept readable; credential-shaped text and sensitive path fields are redacted.
 */
function contentText(value, maxChars) {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const bounded = stripDetailControls(value.slice(0, maxChars * 4));
	const redacted = redactSecretText(redactSensitivePathFields(bounded));
	const trimmed = redacted.trim();
	return trimmed ? truncate(trimmed, maxChars) : undefined;
}

function projectMessage(source) {
	if (!isRecord(source)) return null;
	const role = safeText(source.role, INSPECT_LIMITS.maxRoleChars, { redactPaths: false });
	const kind = typeof source.kind === "string" && MESSAGE_KIND_SET.has(source.kind) ? source.kind : null;
	if (!role || !kind) return null;
	const message = { role, kind, text: contentText(source.text, INSPECT_LIMITS.maxMessageChars) ?? "" };
	const name = safeText(source.name, INSPECT_LIMITS.maxToolNameChars, { redactPaths: false });
	if (name) message.name = name;
	if (source.isError === true) message.isError = true;
	return message;
}

function normalizeTruncated(source) {
	const raw = isRecord(source) ? source : {};
	const messages = Number.isSafeInteger(raw.messages) && raw.messages > 0 ? raw.messages : 0;
	return {
		task: raw.task === true,
		messages,
		finalOutput: raw.finalOutput === true,
	};
}

/**
 * Project one parsed reply into the bounded DTO the page receives.
 *
 * @param {object} reply parsed `pi-subagents.inspect-reply` payload
 * @param {{ requestId?: string }} [options] host-generated id the reply must correlate with
 * @returns {{ ok: true, inspect: object } | { ok: false, reason: string, error?: { code: string, message: string } }}
 */
export function projectInspectReply(reply, { requestId } = {}) {
	if (!isRecord(reply)) return { ok: false, reason: "malformed_reply" };
	if (reply.kind !== INSPECT_REPLY_KIND) return { ok: false, reason: "unexpected_kind" };
	if (reply.version !== INSPECT_REPLY_VERSION) return { ok: false, reason: "unsupported_version" };
	if (!isValidInspectRequestId(reply.requestId)) return { ok: false, reason: "invalid_request_id" };
	if (requestId !== undefined && reply.requestId !== requestId) return { ok: false, reason: "request_id_mismatch" };

	if (isRecord(reply.error)) {
		return {
			ok: false,
			reason: "extension_error",
			error: {
				code: safeCode(reply.error.code, { fallback: "internal", maxChars: INSPECT_LIMITS.maxStatusChars }),
				message: safeText(reply.error.message, INSPECT_LIMITS.maxErrorChars) ?? "pi-subagents inspection failed",
			},
		};
	}

	const rawMessages = Array.isArray(reply.messages) ? reply.messages : [];
	const kept = [];
	for (const entry of rawMessages.slice(0, INSPECT_LIMITS.maxMessages)) {
		const message = projectMessage(entry);
		if (message) kept.push(message);
	}
	const dropped = rawMessages.length - kept.length;

	const truncated = normalizeTruncated(reply.truncated);
	truncated.messages = Math.min(Number.MAX_SAFE_INTEGER, truncated.messages + dropped);

	const inspect = {};
	const asyncId = safeText(reply.asyncId, INSPECT_LIMITS.maxRunIdChars, { redactPaths: false });
	if (asyncId) inspect.asyncId = asyncId;
	const childId = safeText(reply.childId, INSPECT_LIMITS.maxRunIdChars, { redactPaths: false });
	if (childId) inspect.childId = childId;
	const status = safeText(reply.status, INSPECT_LIMITS.maxStatusChars, { redactPaths: false });
	if (status) inspect.status = status;
	const label = safeText(reply.label, INSPECT_LIMITS.maxLabelChars);
	if (label) inspect.label = label;
	const task = contentText(reply.task, INSPECT_LIMITS.maxTaskChars);
	if (task !== undefined) inspect.task = task;
	inspect.messages = kept;
	const finalOutput = contentText(reply.finalOutput, INSPECT_LIMITS.maxFinalOutputChars);
	if (finalOutput !== undefined) inspect.finalOutput = finalOutput;
	inspect.truncated = truncated;
	return { ok: true, inspect };
}

/**
 * Extract every inspect payload line from one captured widget update, bounded and
 * de-duplicated so a misbehaving extension cannot grow host memory.
 */
export function inspectPayloadLines(lines, { maxLines = 8 } = {}) {
	if (!Array.isArray(lines)) return [];
	const found = [];
	for (const line of lines) {
		if (typeof line !== "string" || !line.includes(INSPECT_PAYLOAD_PREFIX)) continue;
		found.push(line);
		if (found.length >= maxLines) break;
	}
	return found;
}

