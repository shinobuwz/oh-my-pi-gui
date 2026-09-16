/**
 * Shared chat message protocol and safe serialization.
 *
 * This module has no data source and no lifecycle: it is the pure layer used by the
 * SDK host chat adapter (`src/host/chat.js`), so the browser contract keeps identical
 * semantics whichever session API feeds it:
 *
 * - bounded, text-safe projection of provider messages (thinking, tool calls, tool
 *   results) with sensitive argument keys and bearer/assignment secrets redacted and
 *   unknown provider blocks omitted;
 * - the per-message revision key (`serializedMessageKey`) used to reconcile live
 *   streaming rows with canonical persisted entries, including the tool-call id key
 *   that de-duplicates a live tool execution row against its persisted tool result.
 */

export const CHAT_LIMITS = Object.freeze({
	maxMessageChars: 64 * 1024,
	maxHistoryItems: 2000,
	maxMessageTextChars: 64 * 1024,
	maxSummaryChars: 32 * 1024,
	maxBlockTextChars: 16 * 1024,
	maxToolArgumentChars: 8 * 1024,
	maxToolOutputChars: 32 * 1024,
	maxBlocksPerMessage: 128,
});

/** Upper bound for asynchronous delivery errors surfaced to the page. */
export const MAX_DELIVERY_ERROR_CHARS = 4096;

/** Message roles that may be projected to the browser. */
export const ALLOWED_ROLES = new Set(["user", "assistant", "toolResult"]);
/** Delivery markers accepted from the browser (normal is idle-only). */
export const KNOWN_DELIVERIES = new Set(["normal", "steer", "followUp"]);
/** Slash-command sources the browser may execute through the public prompt path. */
export const SUPPORTED_COMMAND_SOURCES = new Set(["extension", "prompt", "skill"]);
/** Upper bound of the monotonic chat revision space. */
export const MAX_REVISION = Number.MAX_SAFE_INTEGER;

const MAX_CONTENT_BLOCKS = CHAT_LIMITS.maxBlocksPerMessage;
const MAX_SERIALIZED_DEPTH = 5;
const MAX_SERIALIZED_ITEMS = 64;
const SENSITIVE_ARGUMENT_KEY = /(?:api[-_]?key|access[-_]?key|authorization|credential|password|private[-_]?key|refresh[-_]?token|secret|token)/i;
const BEARER_SECRET = /\bBearer\s+[^\s"'`<>,;)}\]]+/gi;
const SECRET_ASSIGNMENT = /(\b(?:api[-_]?key|access[-_]?key|authorization|credential|private[-_]?key|refresh[-_]?token|key|token|secret|password)\b["']?\s*[:=]\s*)(?:(['"])[^'"\r\n]*\2|([^\s,;}\]\)]+))/gi;

/** Finite numbers only; every other value reads as unavailable. */
export function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Bound text and mark the truncation instead of silently shrinking it. */
export function clipText(value, maxChars = CHAT_LIMITS.maxMessageTextChars) {
	const text = typeof value === "string" ? value : String(value ?? "");
	if (text.length <= maxChars) {
		return text;
	}
	const marker = "\n[output truncated]";
	if (maxChars <= marker.length) {
		return marker.slice(0, Math.max(0, maxChars));
	}
	return `${text.slice(0, maxChars - marker.length)}${marker}`;
}

function redactSecretText(value) {
	return value
		.replace(BEARER_SECRET, "Bearer [redacted]")
		.replace(SECRET_ASSIGNMENT, (_match, prefix, quote) => `${prefix}${quote ? `${quote}[redacted]${quote}` : "[redacted]"}`);
}

function safeJsonValue(value, depth = 0, seen = new Set()) {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
		return typeof value === "string" ? clipText(redactSecretText(value), CHAT_LIMITS.maxToolArgumentChars) : value;
	}
	if (typeof value === "bigint") {
		return `${value}n`;
	}
	if (typeof value === "undefined") {
		return null;
	}
	if (typeof value !== "object") {
		return `[${typeof value} omitted]`;
	}
	if (depth >= MAX_SERIALIZED_DEPTH) {
		return "[depth limited]";
	}
	if (seen.has(value)) {
		return "[circular]";
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const result = value
				.slice(0, MAX_SERIALIZED_ITEMS)
				.map((item) => safeJsonValue(item, depth + 1, seen));
			if (value.length > MAX_SERIALIZED_ITEMS) {
				result.push(`[${value.length - MAX_SERIALIZED_ITEMS} items omitted]`);
			}
			return result;
		}
		const result = {};
		let keys = [];
		try {
			keys = Object.keys(value).slice(0, MAX_SERIALIZED_ITEMS);
		} catch {
			return "[object unavailable]";
		}
		for (const key of keys) {
			if (SENSITIVE_ARGUMENT_KEY.test(key)) {
				result[key] = "[redacted]";
				continue;
			}
			try {
				result[key] = safeJsonValue(value[key], depth + 1, seen);
			} catch {
				result[key] = "[value unavailable]";
			}
		}
		if (Object.keys(value).length > MAX_SERIALIZED_ITEMS) {
			result["[additional keys]"] = "omitted";
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function safeJsonText(value, maxChars = CHAT_LIMITS.maxToolArgumentChars) {
	try {
		return clipText(JSON.stringify(safeJsonValue(value)), maxChars);
	} catch {
		return "[value unavailable]";
	}
}

function safeIdentifier(value, fallback = "unknown", maxChars = 256) {
	return typeof value === "string" && value.length > 0 ? clipText(value, maxChars) : fallback;
}

/** Visible text of a message: text blocks only; thinking/tool blocks are separate. */
export function safeTextContent(content, maxChars = CHAT_LIMITS.maxMessageTextChars) {
	if (typeof content === "string") {
		return clipText(content, maxChars);
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const parts = [];
	for (const block of content.slice(0, MAX_CONTENT_BLOCKS)) {
		if (!block || typeof block !== "object") {
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push("[image omitted]");
		}
		// Thinking and toolCall blocks are serialized separately below. They are not
		// included in visible text or fingerprints as display text.
	}
	return clipText(parts.join(""), maxChars);
}

function serializeContentBlocks(content) {
	if (typeof content === "string") {
		return [{ type: "text", text: clipText(content, CHAT_LIMITS.maxBlockTextChars) }];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	const blocks = [];
	for (const block of content.slice(0, MAX_CONTENT_BLOCKS)) {
		if (!block || typeof block !== "object" || typeof block.type !== "string") {
			continue;
		}
		switch (block.type) {
			case "text":
				if (typeof block.text === "string") {
					blocks.push({ type: "text", text: clipText(block.text, CHAT_LIMITS.maxBlockTextChars) });
				}
				break;
			case "thinking":
				if (typeof block.thinking === "string") {
					blocks.push({ type: "thinking", text: clipText(block.thinking, CHAT_LIMITS.maxBlockTextChars) });
				}
				break;
			case "toolCall": {
				const serialized = {
					type: "toolCall",
					name: safeIdentifier(block.name),
					arguments: safeJsonText(block.arguments),
				};
				if (typeof block.id === "string" && block.id.length > 0) {
					serialized.id = clipText(block.id, 256);
				}
				blocks.push(serialized);
				break;
			}
			case "image":
				blocks.push({ type: "text", text: "[image omitted]" });
				break;
			default:
				// Unknown provider blocks are intentionally omitted instead of exposing
				// raw provider objects to the browser.
				break;
		}
	}
	if (content.length > MAX_CONTENT_BLOCKS && blocks.length < MAX_CONTENT_BLOCKS) {
		blocks.push({ type: "text", text: "[additional content omitted]" });
	}
	return blocks;
}

function serializeToolResultBlock(message, { content = message?.content, isError = message?.isError === true } = {}) {
	const text = safeTextContent(content, CHAT_LIMITS.maxToolOutputChars);
	const rawError = typeof message?.errorMessage === "string"
		? message.errorMessage
		: typeof message?.error === "string"
			? message.error
			: null;
	return {
		type: "toolResult",
		toolCallId: typeof message?.toolCallId === "string" ? clipText(message.toolCallId, 256) : null,
		name: safeIdentifier(message?.toolName, "tool"),
		content: text,
		isError,
		error: rawError ? clipText(rawError, CHAT_LIMITS.maxToolOutputChars) : isError && text ? text : null,
	};
}

function toolContent(result) {
	if (typeof result === "string" || Array.isArray(result)) {
		return result;
	}
	if (!result || typeof result !== "object") {
		return "";
	}
	if (typeof result.content === "string" || Array.isArray(result.content)) {
		return result.content;
	}
	return "";
}

function toolError(result, isError, content) {
	const rawError = result && typeof result === "object"
		? typeof result.errorMessage === "string"
			? result.errorMessage
			: typeof result.error === "string"
				? result.error
				: null
		: null;
	return rawError ? clipText(rawError, CHAT_LIMITS.maxToolOutputChars) : isError && content ? content : null;
}

/** Project one live tool execution record (start/update/end) into a browser row. */
export function serializeToolExecution(record) {
	const content = toolContent(record.result);
	const text = safeTextContent(content, CHAT_LIMITS.maxToolOutputChars);
	const toolCallId = clipText(record.toolCallId, 256);
	const name = safeIdentifier(record.toolName, "tool");
	return {
		id: record.id,
		entryId: null,
		kind: "tool_execution",
		role: "tool",
		toolCallId,
		toolName: name,
		text,
		blocks: [
			{
				type: "toolCall",
				id: toolCallId,
				name,
				arguments: safeJsonText(record.args),
			},
			{
				type: "toolResult",
				toolCallId,
				name,
				content: text,
				isError: record.isError === true,
				error: toolError(record.result, record.isError === true, text),
			},
		],
		isError: record.isError === true,
		status: record.finalized ? "complete" : "running",
		timestamp: null,
	};
}

/**
 * Content fingerprint of a serialized row. Two rows with the same key are the same
 * message; an assistant row and its persisted twin share the key, a toolResult row
 * carries its tool-call id so the execution row can be dropped.
 */
export function serializedMessageKey(message) {
	if (!message || typeof message !== "object") {
		return "";
	}
	return `${message.kind ?? "message"}\u0000${message.role ?? "unknown"}\u0000${message.timestamp ?? ""}\u0000${message.toolCallId ?? ""}\u0000${message.tokensBefore ?? ""}\u0000${message.text ?? ""}\u0000${JSON.stringify(message.blocks ?? [])}`;
}

/** Serialize a raw provider message into the browser row contract; unknown roles are dropped. */
export function serializeMessage(message, id, entryId = null, timestamp = null) {
	if (!message || typeof message !== "object" || !ALLOWED_ROLES.has(message.role)) {
		return null;
	}
	const messageTimestamp = finiteNumber(message.timestamp) ?? finiteNumber(timestamp);
	const serialized = {
		id,
		entryId,
		kind: "message",
		role: message.role,
		text: safeTextContent(message.content),
		blocks: message.role === "toolResult" ? [serializeToolResultBlock(message)] : serializeContentBlocks(message.content),
		timestamp: messageTimestamp,
	};
	if (message.role === "assistant") {
		serialized.stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
		serialized.errorMessage = typeof message.errorMessage === "string" ? clipText(message.errorMessage, 4096) : null;
	} else if (message.role === "toolResult") {
		serialized.toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : null;
		serialized.toolName = typeof message.toolName === "string" ? message.toolName : null;
		serialized.isError = message.isError === true;
	}
	return serialized;
}

/** Fingerprint used to match a live streaming row against itself across updates. */
export function liveMessageKey(message) {
	const serialized = serializeMessage(message, "live:key");
	return serialized ? serializedMessageKey(serialized) : "";
}

/** Serialize one persisted session entry (active-branch history) into the browser row contract. */
export function serializeEntry(entry) {
	if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
		return null;
	}
	if (entry.type === "message") {
		return serializeMessage(entry.message, `entry:${entry.id}`, entry.id, Date.parse(entry.timestamp));
	}
	if (entry.type === "compaction") {
		return {
			id: `entry:${entry.id}`,
			entryId: entry.id,
			kind: "compaction",
			role: "system",
			text: clipText(entry.summary, CHAT_LIMITS.maxSummaryChars),
			tokensBefore: finiteNumber(entry.tokensBefore),
			timestamp: Date.parse(entry.timestamp) || null,
		};
	}
	if (entry.type === "branch_summary") {
		return {
			id: `entry:${entry.id}`,
			entryId: entry.id,
			kind: "branch_summary",
			role: "system",
			text: clipText(entry.summary, CHAT_LIMITS.maxSummaryChars),
			timestamp: Date.parse(entry.timestamp) || null,
		};
	}
	return null;
}

/** Shared rejection shape for every chat adapter action. */
export function failure(status, code, message) {
	return { ok: false, status, code, message };
}

/** Non-attachment result used while the browser chat has no session adapter. */
export function notAttached() {
	return failure(503, "not_attached", "the browser chat is not attached to a session");
}
