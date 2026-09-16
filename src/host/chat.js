/**
 * Browser chat adapter for the SDK host session (work group 2).
 *
 * The browser contract is unchanged from the legacy extension adapter: the same
 * `available/phase/canSend/canSteer/canFollowUp/hasPendingMessages/leafId/revision/
 * messages/messagesFull/historyIds/lastError` snapshot, per-message revisions, `since`
 * deltas and live-vs-canonical de-duplication, so `src/browser/app.js` renders and polls
 * it without modification.
 *
 * Data source (all public `AgentSession` members):
 * - history:   `session.sessionManager.buildContextEntries()` (the active, compaction-aware
 *              branch; `getLeafId()` for the branch leaf)
 * - streaming: `session.subscribe()` events (message_start/update/end,
 *              tool_execution_start/update/end, agent_start/agent_end/agent_settled,
 *              compaction_end, entry_appended)
 * - sending:   `session.prompt(text, options)` with `streamingBehavior: "steer" | "followUp"`
 *              while streaming; idle steer/follow-up selections are normalized to normal
 *              and reported as normalized
 * - stopping:  `session.abort()`
 * - commands:  the public catalog `session.extensionRunner.getRegisteredCommands()` +
 *              `session.promptTemplates` + `session.resourceLoader.getSkills()` (sources
 *              `extension` / `prompt` / `skill` only)
 *
 * Delivery semantics stay explicit: a request that was accepted is never reported as
 * executed. `session.prompt()` resolves only when a normal turn finishes, so the action
 * returns on acceptance and observes the promise separately; an asynchronous rejection
 * (missing model/auth, compaction conflict) or an observable session error event becomes
 * `lastError`, exactly like the previous "failure after acceptance stays visible"
 * behaviour.
 *
 * Slash input fails closed. Only a name found in the public command catalog is forwarded;
 * anything else is refused with an explicit error instead of being sent to the model as a
 * plain prompt. If the session does not expose its command list, slash input is refused as
 * unavailable rather than guessed.
 */

import {
	ALLOWED_ROLES,
	CHAT_LIMITS,
	KNOWN_DELIVERIES,
	MAX_DELIVERY_ERROR_CHARS,
	MAX_REVISION,
	SUPPORTED_COMMAND_SOURCES,
	clipText,
	failure,
	finiteNumber,
	liveMessageKey,
	serializeEntry,
	serializeMessage,
	serializeToolExecution,
	serializedMessageKey,
} from "../core/chat-messages.js";

/** Extension error events that belong to a browser-initiated slash command. */
const COMMAND_ERROR_EVENTS = new Set(["command", "skill_expansion"]);

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Generation-scoped chat control for one SDK session.
 *
 * The adapter subscribes to the session in the constructor and unsubscribes in
 * `dispose()`, so it never keeps a released session alive.
 */
export class HostChatBridge {
	#session;
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
	#unsubscribeSession = null;
	#unsubscribeErrors = null;

	constructor({ session, generation, logger = () => {} } = {}) {
		if (!session || typeof session.prompt !== "function" || typeof session.abort !== "function" || typeof session.subscribe !== "function") {
			throw new Error("HostChatBridge requires an AgentSession with prompt(), abort() and subscribe()");
		}
		if (!session.sessionManager || typeof session.sessionManager.buildContextEntries !== "function") {
			throw new Error("HostChatBridge requires session.sessionManager.buildContextEntries()");
		}
		if (!Number.isInteger(generation) || generation < 1) {
			throw new Error("HostChatBridge requires a positive integer binding generation");
		}
		this.#session = session;
		this.#generation = generation;
		this.#logger = logger;
		this.refreshFromSession();
		this.#subscribeSession();
		this.#subscribeCommandErrors();
	}

	get generation() {
		return this.#generation;
	}

	/** Whether the adapter still owns its session subscription. */
	get active() {
		return this.#active;
	}

	#subscribeSession() {
		try {
			const unsubscribe = this.#session.subscribe((event) => this.handle(event));
			if (typeof unsubscribe === "function") {
				this.#unsubscribeSession = unsubscribe;
			} else {
				this.#logger("browser chat: session.subscribe() did not return an unsubscribe function; streaming rows may continue after shutdown");
			}
		} catch (error) {
			this.#logger(`browser chat: could not subscribe to session events: ${errorMessage(error)}`);
		}
	}

	/**
	 * Surface browser-initiated slash-command failures. Extension commands run inside
	 * `prompt()` and report failures through the public runner error stream instead of
	 * rejecting the prompt promise, so without this subscription they would be invisible.
	 */
	#subscribeCommandErrors() {
		let runner = null;
		try {
			runner = this.#session.extensionRunner;
		} catch {
			return;
		}
		if (!runner || typeof runner.onError !== "function") {
			this.#logger("browser chat: the session does not expose extensionRunner.onError; slash command failures may not be visible in the browser");
			return;
		}
		try {
			const unsubscribe = runner.onError((extensionError) => {
				if (!this.#active || !extensionError || typeof extensionError !== "object") {
					return;
				}
				if (!COMMAND_ERROR_EVENTS.has(extensionError.event)) {
					return;
				}
				const text = clipText(String(extensionError.error ?? ""), MAX_DELIVERY_ERROR_CHARS);
				if (text.length === 0) {
					return;
				}
				const label = extensionError.event === "command" ? "slash command failed" : "skill expansion failed";
				this.#setError(`${label}: ${text}`);
			});
			if (typeof unsubscribe === "function") {
				this.#unsubscribeErrors = unsubscribe;
			} else {
				this.#logger("browser chat: extensionRunner.onError did not return an unsubscribe function; slash command failures may stay invisible");
			}
		} catch (error) {
			this.#logger(`browser chat: could not subscribe to extension errors: ${errorMessage(error)}`);
		}
	}

	/** Re-read the active branch from the public session manager. */
	refreshFromSession() {
		if (!this.#active) {
			return;
		}
		let entries = [];
		try {
			entries = this.#session?.sessionManager?.buildContextEntries() ?? [];
		} catch (error) {
			this.#lastError = "current session history is temporarily unavailable";
			this.#logger(`browser chat history unavailable: ${errorMessage(error)}`);
			this.#touch();
			return;
		}
		const list = Array.isArray(entries) ? entries : [];
		this.#history = list
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

	/** Handle one public `session.subscribe()` event. */
	handle(event) {
		if (!this.#active || !event || typeof event.type !== "string") {
			return;
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
				// The session persists every message_end before it emits agent_end, so the
				// canonical active-branch history is complete here.
				this.refreshFromSession();
				return;
			case "compaction_end":
				this.refreshFromSession();
				return;
			case "entry_appended":
				if (event.entry?.type === "compaction" || event.entry?.type === "branch_summary") {
					this.refreshFromSession();
					return;
				}
				break;
			default:
				// agent_start / agent_settled / queue_update / retry and info events only
				// change the phase and queue state, which the snapshot reads from the session.
				break;
		}
		this.#touch();
	}

	/** Plain state only; never exposes the session, its manager or provider objects. */
	snapshot(options = {}) {
		if (!this.#active) {
			return { available: false };
		}
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
		const phase = this.#phase();
		return {
			available: true,
			phase,
			canSend: phase === "idle",
			canSteer: phase === "streaming",
			canFollowUp: phase === "streaming",
			hasPendingMessages: this.#hasPendingMessages(),
			leafId: this.#leafId(),
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

	/** Stop the current session run for this binding generation. */
	async stop(expectedGeneration, body = {}) {
		const checked = this.#checkRequest(expectedGeneration, body);
		if (checked) {
			return checked;
		}
		return this.#stop(body);
	}

	/**
	 * Surface an asynchronous `prompt()` failure for this binding generation.
	 * Overlong values are rejected instead of forwarded so this seam stays bounded.
	 */
	reportDeliveryError(message) {
		if (!this.#active || typeof message !== "string" || message.length === 0 || message.length > MAX_DELIVERY_ERROR_CHARS) {
			return false;
		}
		this.#setError(`message delivery failed after acceptance: ${message}`);
		return true;
	}

	/** Unsubscribe from the session and drop every browser-visible row. */
	dispose() {
		this.#active = false;
		const unsubscribes = [this.#unsubscribeSession, this.#unsubscribeErrors];
		this.#unsubscribeSession = null;
		this.#unsubscribeErrors = null;
		for (const unsubscribe of unsubscribes) {
			try {
				unsubscribe?.();
			} catch (error) {
				this.#logger(`browser chat: could not unsubscribe from the session: ${errorMessage(error)}`);
			}
		}
		this.#session = null;
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

	/**
	 * Session phase: idle, streaming, or unknown while session work (compaction, branch
	 * summary) owns the session. Sending is refused while unknown instead of accepting a
	 * message the session cannot queue.
	 */
	#phase() {
		let idle = null;
		let streaming = null;
		try {
			idle = this.#session?.isIdle === true;
		} catch {
			idle = null;
		}
		try {
			streaming = this.#session?.isStreaming === true;
		} catch {
			streaming = null;
		}
		if (idle === null || streaming === null) {
			return "unknown";
		}
		if (idle) {
			return "idle";
		}
		return streaming ? "streaming" : "unknown";
	}

	#hasPendingMessages() {
		try {
			const count = this.#session?.pendingMessageCount;
			if (typeof count === "number" && Number.isFinite(count)) {
				return count > 0;
			}
			const steering = this.#session?.getSteeringMessages?.();
			const followUp = this.#session?.getFollowUpMessages?.();
			if (Array.isArray(steering) && Array.isArray(followUp)) {
				return steering.length + followUp.length > 0;
			}
		} catch {
			// Keep unavailable queue state explicit instead of fabricating a value.
		}
		return null;
	}

	#leafId() {
		try {
			const leafId = this.#session?.sessionManager?.getLeafId?.();
			return typeof leafId === "string" ? leafId : null;
		} catch {
			// Keep unavailable branch state explicit instead of fabricating an id.
			return null;
		}
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
			const catalog = this.#commandCatalog();
			const source = catalog.sources.get(commandName);
			if (!source || !SUPPORTED_COMMAND_SOURCES.has(source)) {
				if (!catalog.extensionEnumerable) {
					return failure(
						503,
						"commands_unavailable",
						"the session does not expose its command list, so slash commands are refused instead of being sent to the model",
					);
				}
				return failure(
					409,
					"unsupported_command",
					`/${commandName} is not a supported browser command (only the session's extension, prompt and skill commands are accepted)`,
				);
			}
			commandSource = source;
		}

		const phase = this.#phase();
		if (phase === "unknown") {
			return failure(409, "busy", "the Pi session is not idle or streaming (compaction or session work is in progress); wait for it to settle");
		}
		const idle = phase === "idle";
		if (!idle && requestedDelivery === "normal") {
			return failure(409, "busy", "the Pi agent is busy; choose steer or followUp to queue this message");
		}

		const actualDelivery = idle ? "normal" : requestedDelivery;
		const immediateExtensionCommand = !idle && commandSource === "extension";
		const options = { expandPromptTemplates: true };
		if (!idle) {
			// `prompt()` requires the exact streamingBehavior value while streaming; there
			// is no private fallback for a missing or unknown value.
			options.streamingBehavior = requestedDelivery;
		}
		try {
			// `prompt()` resolves only after a normal turn finishes, so the response
			// reports acceptance or queueing and never that execution completed. The
			// promise is observed separately to keep a later failure visible.
			const result = this.#session.prompt(body.text, options);
			if (result && typeof result.then === "function") {
				result.catch((error) => {
					this.reportDeliveryError(clipText(errorMessage(error), MAX_DELIVERY_ERROR_CHARS));
				});
			}
		} catch (error) {
			return failure(503, "send_failed", errorMessage(error));
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
			const result = this.#session.abort();
			if (result && typeof result.then === "function") {
				result.catch((error) => {
					this.#setError(`stop request failed: ${clipText(errorMessage(error), MAX_DELIVERY_ERROR_CHARS)}`);
				});
			}
		} catch (error) {
			return failure(503, "stop_failed", errorMessage(error));
		}
		this.#touch();
		return { ok: true, requested: true, phase: "stopping" };
	}

	/**
	 * Public command catalog. Only the three browser-supported sources are indexed:
	 * extension commands (invocation names, matching Pi's own dispatch), file-based
	 * prompt templates and `skill:<name>` commands. Built-in TUI commands are absent on
	 * purpose, so they fail closed instead of reaching the model as plain text.
	 */
	#commandCatalog() {
		const sources = new Map();
		let extensionEnumerable = false;
		try {
			const runner = this.#session?.extensionRunner;
			if (runner && typeof runner.getRegisteredCommands === "function") {
				const commands = runner.getRegisteredCommands();
				if (Array.isArray(commands)) {
					for (const command of commands) {
						const invocation = typeof command?.invocationName === "string" && command.invocationName.length > 0
							? command.invocationName
							: typeof command?.name === "string" ? command.name : "";
						if (invocation && !sources.has(invocation)) {
							sources.set(invocation, "extension");
						}
					}
					extensionEnumerable = true;
				}
			}
		} catch (error) {
			this.#logger(`browser chat: extension command list unavailable: ${errorMessage(error)}`);
		}
		try {
			const templates = this.#session?.promptTemplates;
			if (Array.isArray(templates)) {
				for (const template of templates) {
					const name = typeof template?.name === "string" ? template.name : "";
					if (name && !sources.has(name)) {
						sources.set(name, "prompt");
					}
				}
			}
		} catch (error) {
			this.#logger(`browser chat: prompt template list unavailable: ${errorMessage(error)}`);
		}
		try {
			const skills = this.#session?.resourceLoader?.getSkills?.()?.skills;
			if (Array.isArray(skills)) {
				for (const skill of skills) {
					const name = typeof skill?.name === "string" && skill.name.length > 0 ? `skill:${skill.name}` : "";
					if (name && !sources.has(name)) {
						sources.set(name, "skill");
					}
				}
			}
		} catch (error) {
			this.#logger(`browser chat: skill command list unavailable: ${errorMessage(error)}`);
		}
		return { sources, extensionEnumerable };
	}

	#upsertLiveMessage(message, finalized) {
		if (!message || typeof message !== "object" || !ALLOWED_ROLES.has(message.role)) {
			return;
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			// The message lifecycle emits the durable result after tool execution.
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

	#setError(text) {
		this.#lastError = text;
		this.#touch();
	}

	#touch() {
		if (this.#revision < MAX_REVISION) {
			this.#revision += 1;
		}
	}
}
