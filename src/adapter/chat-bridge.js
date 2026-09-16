/**
 * Minimal browser chat adapter for the current Pi session.
 *
 * This module stays on the public ExtensionAPI boundary: user input is delivered
 * with pi.sendUserMessage(), lifecycle data comes from public extension events and
 * the read-only SessionManager, and stop delegates to the current ctx.abort().
 * The private runner capture is deliberately not used as a browser RPC surface.
 *
 * Chat delivery is explicit. Normal input is accepted only while idle; steer and
 * followUp are passed to Pi only while it is streaming. Idle selections are
 * normalized to Pi's immediate normal path and reported as such rather than being
 * presented as queued delivery.
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

/** Upper bound for asynchronous sendUserMessage delivery errors surfaced to the page. */
export const MAX_DELIVERY_ERROR_CHARS = 4096;

const ALLOWED_ROLES = new Set(["user", "assistant", "toolResult"]);
const KNOWN_DELIVERIES = new Set(["normal", "steer", "followUp"]);
const SUPPORTED_COMMAND_SOURCES = new Set(["extension", "prompt", "skill"]);
const MAX_CONTENT_BLOCKS = CHAT_LIMITS.maxBlocksPerMessage;
const MAX_SERIALIZED_DEPTH = 5;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_SERIALIZED_ITEMS = 64;
const SENSITIVE_ARGUMENT_KEY = /(?:api[-_]?key|access[-_]?key|authorization|credential|password|private[-_]?key|refresh[-_]?token|secret|token)/i;
const BEARER_SECRET = /\bBearer\s+[^\s"'`<>,;)}\]]+/gi;
const SECRET_ASSIGNMENT = /(\b(?:api[-_]?key|access[-_]?key|authorization|credential|private[-_]?key|refresh[-_]?token|key|token|secret|password)\b["']?\s*[:=]\s*)(?:(['"])[^'"\r\n]*\2|([^\s,;}\]\)]+))/gi;

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clipText(value, maxChars = CHAT_LIMITS.maxMessageTextChars) {
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

function safeTextContent(content, maxChars = CHAT_LIMITS.maxMessageTextChars) {
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

function serializeToolExecution(record) {
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

function serializedMessageKey(message) {
	if (!message || typeof message !== "object") {
		return "";
	}
	return `${message.kind ?? "message"}\u0000${message.role ?? "unknown"}\u0000${message.timestamp ?? ""}\u0000${message.toolCallId ?? ""}\u0000${message.tokensBefore ?? ""}\u0000${message.text ?? ""}\u0000${JSON.stringify(message.blocks ?? [])}`;
}

function serializeMessage(message, id, entryId = null, timestamp = null) {
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

function liveMessageKey(message) {
	const serialized = serializeMessage(message, "live:key");
	return serialized ? serializedMessageKey(serialized) : "";
}

function serializeEntry(entry) {
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

function failure(status, code, message) {
	return { ok: false, status, code, message };
}

/**
 * Generation-scoped session controller. The registry stores only its explicit
 * snapshot/action callbacks and those callbacks are removed by BrowserBridge on
 * detach, so an old ctx/pi cannot remain reachable after reload.
 */
export class ChatBridge {
	#pi;
	#ctx;
	#generation;
	#logger;
	#active = true;
	#revision = 0;
	#history = [];
	#messageRevisions = new Map();
	#live = [];
	#liveByReference = new Map();
	#liveByToolCallId = new Map();
	#nextLiveId = 1;
	#lastError = null;

	constructor({ pi, ctx, generation, logger = () => {} }) {
		if (!pi || typeof pi.sendUserMessage !== "function") {
			throw new Error("ChatBridge requires pi.sendUserMessage");
		}
		if (!ctx || !ctx.sessionManager) {
			throw new Error("ChatBridge requires a current extension context");
		}
		this.#pi = pi;
		this.#ctx = ctx;
		this.#generation = generation;
		this.#logger = logger;
		this.refreshFromSession(ctx);
	}

	get generation() {
		return this.#generation;
	}

	refreshFromSession(ctx = this.#ctx) {
		if (!this.#active) {
			return;
		}
		if (ctx) {
			this.#ctx = ctx;
		}
		let entries = [];
		try {
			entries = this.#ctx.sessionManager.buildContextEntries();
		} catch (error) {
			this.#lastError = "current session history is temporarily unavailable";
			this.#logger(`chat history unavailable: ${error instanceof Error ? error.message : String(error)}`);
			this.#touch();
			return;
		}
		this.#history = entries
			.map((entry) => serializeEntry(entry))
			.filter(Boolean)
			.slice(-CHAT_LIMITS.maxHistoryItems);
		const canonicalMessageKeys = new Set(
			this.#history
				.filter((entry) => entry.kind === "message" && entry.role !== "toolResult")
				.map((entry) => serializedMessageKey(entry)),
		);
		const canonicalToolCallIds = new Set(
			this.#history
				.filter((entry) => entry.kind === "message" && entry.role === "toolResult" && typeof entry.toolCallId === "string")
				.map((entry) => entry.toolCallId),
		);
		this.#live = this.#live.filter((record) => {
			if (record.kind === "tool_execution" || record.serialized?.role === "toolResult") {
				return !canonicalToolCallIds.has(record.toolCallId ?? record.serialized?.toolCallId);
			}
			// A canonical active-branch message wins even if a reconnect observed it
			// before message_end. This prevents a persisted row and its live twin.
			return !canonicalMessageKeys.has(record.messageKey);
		});
		for (const [message, record] of this.#liveByReference) {
			if (!this.#live.includes(record)) {
				this.#liveByReference.delete(message);
			}
		}
		for (const [toolCallId, record] of this.#liveByToolCallId) {
			if (!this.#live.includes(record)) {
				this.#liveByToolCallId.delete(toolCallId);
			}
		}
		this.#lastError = null;
		this.#touch();
	}

	/** Handle public ExtensionAPI event payloads for the active generation. */
	handle(event, ctx) {
		if (!this.#active || !event || typeof event.type !== "string") {
			return;
		}
		if (ctx) {
			this.#ctx = ctx;
		}
		switch (event.type) {
			case "message_start":
				this.#upsertLiveMessage(event.message, false);
				break;
			case "message_update":
				this.#upsertLiveMessage(event.message, false);
				break;
				case "message_end":
				this.#upsertLiveMessage(event.message, true);
				break;
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
				this.#upsertLiveTool(event);
				break;
			case "agent_end":
				// All message_end persistence has completed before Pi emits agent_end.
				this.refreshFromSession(ctx);
				return;
			case "session_compact":
			case "session_tree":
				this.refreshFromSession(ctx);
				return;
			case "agent_start":
			case "agent_settled":
				this.#touch();
				return;
			default:
				return;
		}
		this.#touch();
	}

	/** Plain state only; never exposes ctx, pi, model registries or session files. */
	snapshot(options = {}) {
		const history = [...this.#history];
		const canonicalMessageKeys = new Set(
			history
				.filter((message) => message.kind === "message" && message.role !== "toolResult")
				.map((message) => serializedMessageKey(message)),
		);
		const canonicalToolCallIds = new Set(
			history
				.filter((message) => message.kind === "message" && message.role === "toolResult" && typeof message.toolCallId === "string")
				.map((message) => message.toolCallId),
		);
		const live = this.#live
			.filter((record) => {
				if (record.kind === "tool_execution" || record.serialized?.role === "toolResult") {
					return !canonicalToolCallIds.has(record.toolCallId ?? record.serialized?.toolCallId);
				}
				return !canonicalMessageKeys.has(record.messageKey);
			})
			.map((record) => record.serialized)
			.filter(Boolean);
		const rawMessages = [...history, ...live];
		const currentIds = new Set(rawMessages.map((message) => message.id));
		for (const id of this.#messageRevisions.keys()) {
			if (!currentIds.has(id)) {
				this.#messageRevisions.delete(id);
			}
		}
		const allMessages = rawMessages.map((message) => this.#withRevision(message));
		const historyIds = allMessages.map((message) => message.id);
		const since = options && typeof options === "object" && !Array.isArray(options) ? options.since : undefined;
		const validSince = Number.isSafeInteger(since) && since >= 0 && since <= MAX_REVISION;
		const messagesFull = !validSince || since > this.#revision;
		const messages = messagesFull
			? allMessages
			: since === this.#revision
				? []
				: allMessages.filter((message) => message.revision > since);
		let phase = "unknown";
		let hasPendingMessages = null;
		let leafId = null;
		try {
			phase = this.#ctx.isIdle() ? "idle" : "streaming";
		} catch {
			// A stale context is never used to control the host; phase remains unknown.
		}
		try {
			hasPendingMessages = this.#ctx.hasPendingMessages();
		} catch {
			// Keep unavailable queue state explicit instead of fabricating a value.
		}
		try {
			leafId = this.#ctx.sessionManager.getLeafId() ?? null;
		} catch {
			// Keep unavailable branch state explicit instead of fabricating an id.
		}
		return {
			available: true,
			phase,
			canSend: phase === "idle",
			canSteer: phase === "streaming",
			canFollowUp: phase === "streaming",
			hasPendingMessages: typeof hasPendingMessages === "boolean" ? hasPendingMessages : null,
			leafId: typeof leafId === "string" ? leafId : null,
			revision: this.#revision,
			messages,
			messagesFull,
			historyIds: messagesFull || (validSince && since < this.#revision) ? historyIds : null,
			lastError: this.#lastError,
		};
	}

	/** Send one explicitly selected browser message for this binding generation. */
	async sendMessage(expectedGeneration, body = {}) {
		const checked = this.#checkRequest(expectedGeneration, body);
		if (checked) {
			return checked;
		}
		return this.#sendMessage(body);
	}

	/** Stop the current Pi run for this binding generation. */
	async stop(expectedGeneration, body = {}) {
		const checked = this.#checkRequest(expectedGeneration, body);
		if (checked) {
			return checked;
		}
		return this.#stop(body);
	}

	/**
	 * Surface an asynchronous sendUserMessage failure for this binding generation.
	 * The browser bridge clips the host error before calling this method; rejecting
	 * oversized values here keeps this public seam bounded even for direct callers.
	 */
	reportDeliveryError(message) {
		if (!this.#active || typeof message !== "string" || message.length === 0 || message.length > MAX_DELIVERY_ERROR_CHARS) {
			return false;
		}
		this.#lastError = `message delivery failed after acceptance: ${message}`;
		this.#touch();
		return true;
	}

	dispose() {
		this.#active = false;
		this.#pi = null;
		this.#ctx = null;
		this.#history = [];
		this.#live = [];
		this.#messageRevisions.clear();
		this.#liveByReference.clear();
		this.#liveByToolCallId.clear();
	}

	#checkRequest(expectedGeneration, body) {
		if (!this.#active || expectedGeneration !== this.#generation) {
			return failure(409, "stale_generation", "the browser session generation is no longer current");
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return failure(400, "invalid_body", "body must be a JSON object");
		}
		return null;
	}

	#sendMessage(body) {
		const keys = Object.keys(body);
		if (keys.some((key) => !["text", "generation", "delivery", "deliverAs"].includes(key))) {
			return failure(400, "invalid_body", "message requests only accept text, generation and an explicit delivery marker");
		}
		if (body.generation !== this.#generation) {
			return failure(409, "stale_generation", "the browser session generation is no longer current");
		}
		if (typeof body.text !== "string") {
			return failure(400, "invalid_text", "message text must be a string");
		}
		if (body.text.trim().length === 0) {
			return failure(400, "empty_message", "message text must not be empty");
		}
		if (body.text.length > CHAT_LIMITS.maxMessageChars) {
			return failure(413, "message_too_long", `message text is limited to ${CHAT_LIMITS.maxMessageChars} characters`);
		}

		const requestedDeliveries = [body.delivery, body.deliverAs].filter((value) => value !== undefined);
		if (requestedDeliveries.length > 0 && (new Set(requestedDeliveries).size !== 1 || !KNOWN_DELIVERIES.has(requestedDeliveries[0]))) {
			return failure(409, "unsupported_delivery", "delivery must be one of normal, steer, or followUp");
		}
		const requestedDelivery = requestedDeliveries[0] ?? "normal";

		let commandSource = null;
		const trimmedText = body.text.trimStart();
		if (trimmedText.startsWith("/") && trimmedText !== body.text) {
			return failure(409, "unsupported_command", "slash commands must start at the first character with no leading whitespace");
		}
		if (body.text.startsWith("/")) {
			const commandMatch = /^([^\s]+)/u.exec(body.text.slice(1));
			const commandName = commandMatch?.[1] ?? "";
			if (!commandName) {
				return failure(409, "unsupported_command", "slash commands require a supported command name with no whitespace after the slash");
			}
			let commands;
			try {
				commands = this.#pi.getCommands?.() ?? [];
			} catch {
				return failure(503, "commands_unavailable", "supported extension commands are temporarily unavailable");
			}
			let supportedCommand = null;
			if (Array.isArray(commands)) {
				for (const command of commands) {
					try {
						if (
							command
							&& typeof command === "object"
							&& !Array.isArray(command)
							&& typeof command.name === "string"
							&& command.name === commandName
							&& SUPPORTED_COMMAND_SOURCES.has(command.source)
						) {
							supportedCommand = command;
							break;
						}
					} catch {
						// Ignore malformed command descriptors and continue the allowlist scan.
					}
				}
			}
			if (!supportedCommand) {
				return failure(409, "unsupported_command", `/${commandName} is not a supported browser command`);
			}
			commandSource = supportedCommand.source;
		}

		let idle;
		try {
			idle = this.#ctx.isIdle();
		} catch {
			return failure(409, "stale_generation", "the current Pi context is no longer active");
		}
		if (!idle && requestedDelivery === "normal") {
			return failure(409, "busy", "the Pi agent is busy; choose steer or followUp to queue this message");
		}

		const actualDelivery = idle ? "normal" : requestedDelivery;
		const immediateExtensionCommand = !idle && commandSource === "extension";
		const options = { expandPromptTemplates: true };
		if (!idle) {
			// Pi's public sendUserMessage API requires the exact camel-case value
			// while streaming. Do not substitute a private runner call or a fallback.
			options.deliverAs = requestedDelivery;
		}
		try {
			// The extension API intentionally fire-and-forgets this call. The response
			// reports immediate acceptance or queueing, never claims that execution has
			// completed. Direct Promise-returning test doubles are observed only to keep
			// a later asynchronous failure visible in the session snapshot.
			const result = this.#pi.sendUserMessage(body.text, options);
			if (result && typeof result.then === "function") {
				result.catch((error) => {
					const message = clipText(error instanceof Error ? error.message : String(error), MAX_DELIVERY_ERROR_CHARS);
					this.reportDeliveryError(message);
				});
			}
		} catch (error) {
			return failure(503, "send_failed", error instanceof Error ? error.message : String(error));
		}
		this.#lastError = null;
		this.#touch();
		return {
			ok: true,
			accepted: true,
			queued: !idle && !immediateExtensionCommand,
			delivery: actualDelivery,
			requestedDelivery,
			execution: immediateExtensionCommand ? "immediate" : "pending",
			phase: idle ? "starting" : "streaming",
			...(immediateExtensionCommand ? { message: "extension slash command executed immediately; it is not part of the delivery queue" } : {}),
			...(actualDelivery !== requestedDelivery ? { normalized: true } : {}),
		};
	}

	#stop(body) {
		const keys = Object.keys(body);
		if (keys.some((key) => key !== "generation")) {
			return failure(400, "invalid_body", "stop requests only accept generation");
		}
		if (body.generation !== this.#generation) {
			return failure(409, "stale_generation", "the browser session generation is no longer current");
		}
		try {
			this.#ctx.abort();
		} catch (error) {
			return failure(503, "stop_failed", error instanceof Error ? error.message : String(error));
		}
		this.#touch();
		return { ok: true, requested: true, phase: "stopping" };
	}

	#upsertLiveMessage(message, finalized) {
		if (!message || typeof message !== "object" || !ALLOWED_ROLES.has(message.role)) {
			return;
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			// The public message lifecycle emits the durable result after tool execution.
			// Replace the temporary execution row with this canonical message instead of
			// showing the same tool twice.
			this.#removeLiveTool(message.toolCallId);
		}
		const messageKey = liveMessageKey(message);
		let record = this.#liveByReference.get(message);
		if (!record) {
			record = this.#live.find((candidate) => candidate.kind === "message" && candidate.messageKey === messageKey && !candidate.finalized);
		}
		if (!record && (message.role === "assistant" || message.role === "toolResult")) {
			// Pi normally reuses the streaming message object. Keep a stable row even
			// for a host/test boundary that supplies a fresh object on each update.
			const timestamp = finiteNumber(message.timestamp);
			for (let index = this.#live.length - 1; index >= 0; index -= 1) {
				const candidate = this.#live[index];
				const sameTool = message.role === "toolResult" && candidate.message?.toolCallId === message.toolCallId;
				const sameAssistant = message.role === "assistant" && candidate.message?.role === "assistant" && (timestamp === null || candidate.message.timestamp === timestamp);
				if (candidate.kind === "message" && !candidate.finalized && (sameTool || sameAssistant)) {
					record = candidate;
					break;
				}
			}
		}
		if (!record) {
			record = {
				id: `live:${this.#nextLiveId++}`,
				kind: "message",
				message,
				messageKey,
				finalized: false,
				serialized: null,
			};
			this.#live.push(record);
		}
		record.kind = "message";
		record.message = message;
		record.messageKey = messageKey;
		record.finalized = record.finalized || finalized;
		record.serialized = serializeMessage(message, record.id);
		for (const [reference, mapped] of this.#liveByReference) {
			if (mapped === record && reference !== message) {
				this.#liveByReference.delete(reference);
			}
		}
		this.#liveByReference.set(message, record);
		this.#trimLive();
	}

	#upsertLiveTool(event) {
		if (!event || typeof event.toolCallId !== "string" || event.toolCallId.length === 0) {
			return;
		}
		let record = this.#liveByToolCallId.get(event.toolCallId);
		if (!record) {
			record = {
				id: `live:${this.#nextLiveId++}`,
				kind: "tool_execution",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				result: null,
				isError: false,
				finalized: false,
				serialized: null,
			};
			this.#live.push(record);
			this.#liveByToolCallId.set(event.toolCallId, record);
		}
		if (typeof event.toolName === "string" && event.toolName.length > 0) {
			record.toolName = event.toolName;
		}
		if (event.args !== undefined) {
			record.args = event.args;
		}
		if (event.type === "tool_execution_update") {
			record.result = event.partialResult;
		} else if (event.type === "tool_execution_end") {
			record.result = event.result;
			record.isError = event.isError === true;
			record.finalized = true;
		}
		record.serialized = serializeToolExecution(record);
		this.#trimLive();
	}

	#removeLiveTool(toolCallId) {
		const record = this.#liveByToolCallId.get(toolCallId);
		if (!record) {
			return;
		}
		this.#liveByToolCallId.delete(toolCallId);
		const index = this.#live.indexOf(record);
		if (index !== -1) {
			this.#live.splice(index, 1);
		}
	}

	#withRevision(message) {
		const key = serializedMessageKey(message);
		const previous = this.#messageRevisions.get(message.id);
		const sameContent = previous && previous.key === key;
		let revision = sameContent ? previous.revision : this.#revision;
		if (!sameContent && previous && revision <= previous.revision) {
			revision = previous.revision + 1;
			this.#revision = revision;
		}
		this.#messageRevisions.set(message.id, { key, revision });
		return { ...message, revision };
	}

	#trimLive() {
		if (this.#live.length <= CHAT_LIMITS.maxHistoryItems) {
			return;
		}
		const removed = new Set(this.#live.splice(0, this.#live.length - CHAT_LIMITS.maxHistoryItems));
		for (const [reference, mapped] of this.#liveByReference) {
			if (removed.has(mapped)) {
				this.#liveByReference.delete(reference);
			}
		}
		for (const [toolCallId, mapped] of this.#liveByToolCallId) {
			if (removed.has(mapped)) {
				this.#liveByToolCallId.delete(toolCallId);
			}
		}
	}

	#touch() {
		if (this.#revision < MAX_REVISION) {
			this.#revision += 1;
		}
	}
}

export { clipText, safeTextContent, serializeEntry, serializeMessage };
