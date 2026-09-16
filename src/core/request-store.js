/**
 * Host-side request store for the browser interaction prototype.
 *
 * Owns every prompt request that the browser adapter intercepts. Requests live in
 * host memory only, are addressed by a host-generated request id, and survive
 * browser disconnects until the original consumer contract ends them
 * (explicit browser answer, explicit cancel, consumer timeout, consumer abort,
 * session shutdown).
 *
 * Resolution semantics follow the Pi 0.85.1 extension dialog contract:
 * `confirm` resolves to a boolean (non-approval `false`), `select`/`input`/`editor`
 * resolve to a string or `undefined`, `custom` resolves to the caller's value type
 * (non-approval `undefined`).
 */

import { randomUUID } from "node:crypto";

export const KINDS = Object.freeze(["confirm", "select", "input", "editor", "custom"]);

/** Non-approval results per kind (never an approval). */
export const NON_APPROVAL = Object.freeze({
	confirm: false,
	select: undefined,
	input: undefined,
	editor: undefined,
	custom: undefined,
});

export const LIMITS = Object.freeze({
	/** Maximum accepted HTTP request body: covers 64 Ki characters at 4-byte UTF-8 plus JSON wrapper overhead. */
	maxBodyBytes: 320 * 1024,
	/** Maximum accepted characters for an `input` answer. */
	inputChars: 4096,
	/** Maximum accepted characters for an `editor` answer. */
	editorChars: 64 * 1024,
	/** Maximum accepted characters for a browser-provided request id. */
	idChars: 128,
	/** Maximum number of options echoed to the browser for a `select`. */
	options: 200,
	/** Resolved request ids kept for late/duplicate reply rejection. */
	resolvedHistory: 128,
});

const ANSWER = "answer";
const CANCEL = "cancel";
const DISMISS = "dismiss";

/** Unsupported custom-prompt notices kept pending for the browser to display. */
const MAX_UNSUPPORTED_NOTICES = 5;

function bump(state) {
	state.revision += 1;
}

export class RequestStore {
	#pending = new Map();
	#resolved = new Map();
	#state = { revision: 0 };
	#generation = 0;
	#now;

	constructor({ now = () => Date.now() } = {}) {
		this.#now = now;
	}

	/** Current binding generation. Bumped when extensions are rebound (for example reload). */
	get generation() {
		return this.#generation;
	}

	/**
	 * Move to a new binding generation. Requests created before the bump can no
	 * longer be answered, and any pending request of the previous generation must be
	 * ended by the caller with its non-approval result.
	 */
	setGeneration(generation) {
		this.#generation = Number(generation) || 0;
	}

	get revision() {
		return this.#state.revision;
	}

	get pendingCount() {
		return this.#pending.size;
	}

	/**
	 * Create a pending request that a browser client can answer.
	 *
	 * @returns {{ id: string, promise: Promise<unknown> }}
	 */
	create({
		kind,
		title = "",
		message = "",
		placeholder = "",
		prefill = "",
		options,
		timeoutMs,
		signal,
		unsupported = false,
		unsupportedReason = "",
	}) {
		if (!KINDS.includes(kind)) {
			throw new Error(`unsupported request kind: ${String(kind)}`);
		}
		const id = randomUUID();
		const createdAt = this.#now();
		const request = {
			id,
			kind,
			title: String(title ?? ""),
			message: String(message ?? ""),
			placeholder: String(placeholder ?? ""),
			prefill: String(prefill ?? ""),
			options: Array.isArray(options) ? options.map(String).slice(0, LIMITS.options) : null,
			createdAt,
			deadlineAt: null,
			unsupported,
			unsupportedReason: String(unsupportedReason ?? ""),
			generation: this.#generation,
			settled: false,
			signal: null,
			onAbort: null,
			timer: null,
			resolve: null,
			reject: null,
		};

		const promise = new Promise((resolve, reject) => {
			request.resolve = resolve;
			request.reject = reject;
		});
		// The host always awaits this promise (through the patched dialog method);
		// attach a no-op handler so a store-level rejection is never unhandled.
		promise.catch(() => {});

		const abortSettled = this.#applyPreconditions(request, { timeoutMs, signal });
		if (!abortSettled) {
			this.#pending.set(id, request);
			bump(this.#state);
		}
		return { id, promise };
	}

	/**
	 * Create a browser-visible notice for an interaction the prototype cannot answer.
	 * The notice is dismissible in the browser and never answerable. At most
	 * `MAX_UNSUPPORTED_NOTICES` notices stay pending so a long session cannot grow
	 * without bound; the oldest one is retired (still without approval).
	 */
	createUnsupportedNotice({ title, message }) {
		const { id } = this.create({
			kind: "custom",
			title,
			message,
			unsupported: true,
			unsupportedReason: message,
		});
		const notices = [...this.#pending.values()].filter((request) => request.unsupported);
		for (const stale of notices.slice(0, Math.max(0, notices.length - MAX_UNSUPPORTED_NOTICES))) {
			this.#finalize(stale, { status: "superseded", value: NON_APPROVAL[stale.kind] });
		}
		return id;
	}

	/** True when the id belongs to a still-pending request. */
	isPending(id) {
		return typeof id === "string" && this.#pending.has(id);
	}

	/** Resolution history for observability/tests: `{ id, kind, status }`. */
	get resolvedHistory() {
		return [...this.#resolved.values()].map((entry) => ({ ...entry }));
	}

	#applyPreconditions(request, { timeoutMs, signal }) {
		if (signal) {
			if (typeof signal.addEventListener !== "function") {
				throw new Error("signal must be an AbortSignal");
			}
			if (signal.aborted === true) {
				this.#finalize(request, { status: "aborted", value: NON_APPROVAL[request.kind], notify: false });
				return true;
			}
			request.onAbort = () => {
				this.#finalize(request, { status: "aborted", value: NON_APPROVAL[request.kind] });
			};
			request.signal = signal;
			signal.addEventListener("abort", request.onAbort, { once: true });
		}
		const timeout = Number(timeoutMs);
		if (Number.isFinite(timeout) && timeout > 0) {
			request.deadlineAt = this.#now() + timeout;
			request.timer = setTimeout(() => {
				this.#finalize(request, { status: "timeout", value: NON_APPROVAL[request.kind] });
			}, timeout);
		}
		return false;
	}

	#finalize(request, { status, value, notify = true }) {
		if (request.settled) {
			return false;
		}
		request.settled = true;
		if (request.timer) {
			clearTimeout(request.timer);
			request.timer = null;
		}
		if (request.signal && request.onAbort) {
			request.signal.removeEventListener("abort", request.onAbort);
			request.onAbort = null;
		}
		this.#pending.delete(request.id);
		this.#remember(request.id, { id: request.id, kind: request.kind, status, unsupported: request.unsupported, at: this.#now() });
		if (notify) {
			bump(this.#state);
		}
		request.resolve(value);
		return true;
	}

	#remember(id, entry) {
		this.#resolved.set(id, entry);
		while (this.#resolved.size > LIMITS.resolvedHistory) {
			const oldest = this.#resolved.keys().next().value;
			this.#resolved.delete(oldest);
		}
	}

	/**
	 * Apply a browser reply.
	 *
	 * @returns {{ ok: true, status: string, id: string, kind: string } | { ok: false, status: number, code: string, message: string }}
	 */
	answer(id, payload) {
		if (typeof id !== "string" || id.length === 0 || id.length > LIMITS.idChars) {
			return fail(400, "invalid_request_id", "request id must be a non-empty string");
		}
		const action = payload?.action;
		if (action !== ANSWER && action !== CANCEL && action !== DISMISS) {
			return fail(400, "invalid_action", 'action must be "answer", "cancel" or "dismiss"');
		}
		const request = this.#pending.get(id);
		if (!request) {
			const late = this.#resolved.get(id);
			if (late) {
				return fail(409, "already_resolved", `request ${id} was already resolved (${late.status})`);
			}
			return fail(404, "unknown_request", `request ${id} is not pending`);
		}

		if (action === DISMISS) {
			if (request.unsupported) {
				this.#finalize(request, { status: "dismissed", value: NON_APPROVAL[request.kind] });
				return { ok: true, status: "dismissed", id, kind: request.kind };
			}
			return fail(400, "invalid_action", 'action "dismiss" is only valid for unsupported notices');
		}

		if (request.generation !== this.#generation) {
			return fail(
				409,
				"stale_generation",
				`request ${id} belongs to binding generation ${request.generation}, current generation is ${this.#generation}`,
			);
		}

		if (request.unsupported) {
			return fail(409, "unsupported_request", `request ${id} cannot be answered from the browser (unsupported interaction)`);
		}

		if (action === CANCEL) {
			this.#finalize(request, { status: "cancelled", value: NON_APPROVAL[request.kind] });
			return { ok: true, status: "cancelled", id, kind: request.kind };
		}

		const validation = validateAnswer(request, payload?.value);
		if (!validation.ok) {
			return validation;
		}
		this.#finalize(request, { status: "answered", value: validation.value });
		return { ok: true, status: "answered", id, kind: request.kind };
	}

	/** Snapshot for browser clients; contains no server-internal fields. */
	snapshot() {
		return {
			revision: this.#state.revision,
			pending: [...this.#pending.values()].map((request) => ({
				id: request.id,
				kind: request.kind,
				title: request.title,
				message: request.message,
				placeholder: request.placeholder,
				prefill: request.prefill,
				options: request.options,
				createdAt: request.createdAt,
				deadlineAt: request.deadlineAt,
				unsupported: request.unsupported,
				unsupportedReason: request.unsupportedReason,
			})),
		};
	}

	/**
	 * End every pending request with its non-approval result.
	 * Used by session shutdown / reload cleanup; never approves anything.
	 */
	cancelAll(reason = "shutdown") {
		const cancelled = [];
		for (const request of [...this.#pending.values()]) {
			this.#finalize(request, { status: reason, value: NON_APPROVAL[request.kind], notify: false });
			cancelled.push({ id: request.id, kind: request.kind });
		}
		if (cancelled.length > 0) {
			bump(this.#state);
		}
		return cancelled;
	}
}

function validateAnswer(request, value) {
	switch (request.kind) {
		case "confirm":
			if (typeof value !== "boolean") {
				return fail(400, "invalid_value", "confirm answers must be a boolean");
			}
			return { ok: true, value };
		case "select":
			if (typeof value !== "string") {
				return fail(400, "invalid_value", "select answers must be a string");
			}
			if (!Array.isArray(request.options) || !request.options.includes(value)) {
				return fail(400, "invalid_value", "select answers must match one of the offered options");
			}
			return { ok: true, value };
		case "input":
			if (typeof value !== "string") {
				return fail(400, "invalid_value", "input answers must be a string");
			}
			if (value.length > LIMITS.inputChars) {
				return fail(413, "value_too_long", `input answers are limited to ${LIMITS.inputChars} characters`);
			}
			return { ok: true, value };
		case "editor":
			if (typeof value !== "string") {
				return fail(400, "invalid_value", "editor answers must be a string");
			}
			if (value.length > LIMITS.editorChars) {
				return fail(413, "value_too_long", `editor answers are limited to ${LIMITS.editorChars} characters`);
			}
			return { ok: true, value };
		default:
			return fail(409, "unsupported_request", `request kind ${request.kind} cannot be answered from the browser`);
	}
}

function fail(status, code, message) {
	return { ok: false, status, code, message };
}
