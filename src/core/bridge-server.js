/**
 * Loopback HTTP bridge for the browser GUI host (transport layer reused from the
 * previous browser-interaction prototype, pinned by its own tests).
 *
 * Design constraints (see openspec/changes/browser-interaction-spike/spec.md):
 * - binds 127.0.0.1 only, on an ephemeral port
 * - unpredictable per-session bearer token, exact Host and Origin validation
 * - rejects cross-site writes, limits request size, validates every value
 * - serves only three allow-listed local assets, no CDN, no file reads by path
 * - no long-lived resources are created here; the caller owns start/stop
 */

import { createServer as createHttpServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { INSPECT_LIMITS } from "./inspect-reply.js";
import { LIMITS } from "./request-store.js";

const HOST = "127.0.0.1";

/**
 * Browser-blocked HTTP(S) ports: the undici (Node fetch) bad-port set plus
 * Chromium ERR_UNSAFE_PORT extra items. The post-bind client self-check below
 * remains the guard against future client-list drift.
 */
export const BROWSER_BLOCKED_PORTS = Object.freeze([
	1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
	101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 138, 139, 143, 161, 179,
	389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
	587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
	5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const BROWSER_BLOCKED_PORT_SET = new Set(BROWSER_BLOCKED_PORTS);
const MAX_BIND_ATTEMPTS = 10;

/**
 * Hard upper bound for the post-bind client self-check fetch. A client fetch that
 * never settles (injected or proxied during tests, a wedged host in production) must
 * never pin `startBridgeServer` or the session-start await that owns it.
 */
export const CLIENT_SELF_CHECK_TIMEOUT_MS = 1500;

/** Return whether a TCP port is rejected by browsers for HTTP(S) fetches. */
export function isBrowserBlockedPort(port) {
	return Number.isInteger(port) && BROWSER_BLOCKED_PORT_SET.has(port);
}

/** Flatten a nested `cause` chain into one diagnostic line; `token` is redacted when present. */
export function formatErrorWithCause(error, token = "") {
	const parts = [];
	const seen = new Set();
	let current = error;
	while (current !== undefined && current !== null && !seen.has(current) && parts.length < 8) {
		seen.add(current);
		const message = current instanceof Error
			? current.message
			: typeof current?.message === "string"
				? current.message
				: String(current);
		parts.push(message);
		current = current?.cause;
	}
	const detail = parts.reduce((text, part, index) => index === 0 ? part : `${text}; cause: ${part}`, "");
	return token && detail.includes(token) ? detail.replaceAll(token, "[redacted]") : detail;
}

/** Return whether an error or any of its (cycle-safe) causes carries `expectedCode`. */
export function hasErrorCode(error, expectedCode) {
	const seen = new Set();
	let current = error;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		if (current?.code === expectedCode) {
			return true;
		}
		current = current?.cause;
	}
	return false;
}

/** Identify errors where the client itself refuses the selected HTTP port. */
export function isClientRejectedPortError(error) {
	return hasErrorCode(error, "ERR_UNSAFE_PORT") || /\b(?:bad|unsafe)[\s_-]*port\b/i.test(formatErrorWithCause(error));
}

/**
 * Ask the real client (or the injected seam) to prove it can reach the bound port.
 *
 * The check is bounded twice on purpose: the abort signal tells a real fetch to stop
 * and release its socket, while the timer guarantees the await itself settles even when
 * the fetch implementation ignores signals. A timeout is diagnostic only
 * (`outcome: "inconclusive"`, `timedOut: true`): the listener is already bound, so the
 * URL is still published instead of hanging or failing closed.
 */
async function runClientSelfCheck(clientFetch, port, token, { timeoutMs = CLIENT_SELF_CHECK_TIMEOUT_MS } = {}) {
	if (typeof clientFetch !== "function") {
		return {
			ok: false,
			outcome: "network-error",
			port,
			status: null,
			timedOut: false,
			error: "the client fetch function is unavailable",
		};
	}
	const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CLIENT_SELF_CHECK_TIMEOUT_MS;
	const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(boundedTimeoutMs) : undefined;
	let timer = null;
	try {
		const response = await new Promise((resolve, reject) => {
			timer = setTimeout(() => {
				const timeoutError = new Error(`the client self-check fetch did not settle within ${boundedTimeoutMs}ms`);
				timeoutError.code = "self_check_timeout";
				reject(timeoutError);
			}, boundedTimeoutMs);
			// `redirect: "manual"` keeps a redirecting client from leaving the loopback
			// self-check semantics: only the bound origin proves reachability.
			Promise.resolve()
				.then(() => clientFetch(`http://${HOST}:${port}/api/state`, {
					headers: { Authorization: `Bearer ${token}` },
					redirect: "manual",
					...(signal ? { signal } : {}),
				}))
				.then(resolve, reject);
		});
		return {
			ok: true,
			outcome: "reachable",
			port,
			status: Number.isInteger(response?.status) ? response.status : null,
			timedOut: false,
			error: null,
		};
	} catch (error) {
		const timedOut = error?.code === "self_check_timeout" || signal?.aborted === true;
		return {
			ok: false,
			outcome: timedOut ? "inconclusive" : isClientRejectedPortError(error) ? "client-rejected" : "network-error",
			port,
			status: null,
			timedOut,
			error: formatErrorWithCause(error, token) || "unknown client self-check failure",
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Static asset allow-list: URL path -> file name inside `assetsDir`. */
export const ASSET_ROUTES = Object.freeze({
	"/": "index.html",
	"/index.html": "index.html",
	"/app.js": "app.js",
	"/app.css": "app.css",
});

const CONTENT_TYPES = Object.freeze({
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
});

const CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"connect-src 'self'",
	"img-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = Object.freeze({
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Cross-Origin-Opener-Policy": "same-origin",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": CSP,
});

const POST_BODY_KEYS = Object.freeze({
	"/api/reload": Object.freeze([]),
	"/api/answer": Object.freeze(["id", "action", "value"]),
	"/api/message": Object.freeze(["generation", "text", "delivery", "deliverAs"]),
	"/api/stop": Object.freeze(["generation"]),
	"/api/model": Object.freeze(["generation", "key"]),
	"/api/thinking": Object.freeze(["generation", "level"]),
	"/api/subagents/details": Object.freeze(["generation", "id"]),
	"/api/subagents/refresh": Object.freeze(["generation"]),
	"/api/subagents/inspect": Object.freeze(["generation", "id", "childId", "lines"]),
});

/** Route paths of the read-only subagents slice (details / structured inspect / refresh). */
const SUBAGENT_ROUTES = Object.freeze(["/api/subagents/details", "/api/subagents/refresh", "/api/subagents/inspect"]);

/** Create an unpredictable per-session bearer token. */
export function createBridgeToken() {
	return randomBytes(32).toString("hex");
}

function tokenMatches(expected, provided) {
	if (typeof provided !== "string") {
		return false;
	}
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	if (a.length !== b.length || a.length === 0) {
		return false;
	}
	return timingSafeEqual(a, b);
}

function parseChatSince(rawUrl) {
	const queryIndex = rawUrl.indexOf("?");
	if (queryIndex === -1) {
		return undefined;
	}
	try {
		const values = new URLSearchParams(rawUrl.slice(queryIndex + 1)).getAll("since");
		const value = values.length === 1 ? values[0] : null;
		return /^\d{1,12}$/.test(value ?? "") ? Number(value) : undefined;
	} catch {
		return undefined;
	}
}

function bearerToken(req) {
	const header = req.headers.authorization;
	if (typeof header !== "string") {
		return null;
	}
	const match = /^Bearer (\S+)$/.exec(header.trim());
	return match ? match[1] : null;
}

function sendJson(res, status, body) {
	const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
	res.writeHead(status, {
		...SECURITY_HEADERS,
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": payload.length,
	});
	res.end(payload);
}

function sendError(res, status, code, message) {
	sendJson(res, status, { ok: false, error: { code, message } });
}

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > LIMITS.maxBodyBytes) {
			const error = new Error(`request body exceeds ${LIMITS.maxBodyBytes} bytes`);
			error.code = "body_too_large";
			throw error;
		}
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.trim().length === 0) {
		const error = new Error("request body must be JSON");
		error.code = "invalid_json";
		throw error;
	}
	try {
		return JSON.parse(raw);
	} catch {
		const error = new Error("request body must be valid JSON");
		error.code = "invalid_json";
		throw error;
	}
}

/** Empty lifecycle used when a caller binds the server without reload support. */
const NO_LIFECYCLE = Object.freeze({
	snapshot: () => ({ generation: 0, reloading: false }),
	reload: async () => ({ ok: false, status: 503, code: "reload_unavailable", message: "reload is not available for this bridge" }),
	sessionSnapshot: () => null,
	sessionMessage: async () => ({ ok: false, status: 503, code: "not_attached", message: "the browser chat is not attached to a session" }),
	sessionStop: async () => ({ ok: false, status: 503, code: "not_attached", message: "the browser chat is not attached to a session" }),
	sessionModel: async () => ({ ok: false, status: 503, code: "not_attached", message: "the browser model controls are not attached to a session" }),
	sessionThinking: async () => ({ ok: false, status: 503, code: "not_attached", message: "the browser thinking controls are not attached to a session" }),
	sessionSubagentsDetails: async () => ({ ok: false, status: 503, code: "not_attached", message: "the browser subagent status is not attached to a session" }),
	sessionSubagentsInspect: async () => ({ ok: false, status: 503, code: "not_attached", message: "the browser subagent status is not attached to a session" }),
	sessionSubagentsRefresh: async () => ({ ok: false, status: 503, code: "not_attached", message: "the browser subagent status is not attached to a session" }),
});

function listenBridgeServer(server, options, listen) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error = null) => {
			if (settled) {
				return;
			}
			settled = true;
			server.removeListener?.("error", onError);
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const onError = (error) => finish(error);
		server.once("error", onError);
		try {
			listen(server, options, () => finish());
		} catch (error) {
			finish(error);
		}
	});
}

function closeBridgeServer(server) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error = null) => {
			if (settled) {
				return;
			}
			settled = true;
			if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
				reject(error);
			} else {
				resolve();
			}
		};
		server.closeAllConnections?.();
		try {
			server.close(finish);
		} catch (error) {
			finish(error);
		}
	});
}

/**
 * Start the loopback bridge.
 *
 * @param {object} options
 * @param {import("./request-store.js").RequestStore} options.store
 * @param {string} options.assetsDir directory holding index.html/app.js/app.css
 * @param {string} [options.token]
 * @param {{ snapshot: () => { generation: number, reloading: boolean }, reload: () => Promise<{ ok: boolean, status?: number, code?: string, message?: string, generation?: number }>, sessionSnapshot?: (options?: { chatSince?: number }) => object | null, sessionMessage?: (generation: number, body: object) => Promise<{ ok: boolean, status?: number, code?: string, message?: string, [key: string]: unknown }>, sessionStop?: (generation: number, body: object) => Promise<{ ok: boolean, status?: number, code?: string, message?: string, [key: string]: unknown }>, sessionModel?: (generation: number, body: object) => Promise<{ ok: boolean, status?: number, code?: string, message?: string, [key: string]: unknown }>, sessionThinking?: (generation: number, body: object) => Promise<{ ok: boolean, status?: number, code?: string, message?: string, [key: string]: unknown }>, sessionSubagentsDetails?: (generation: number, body: object) => Promise<{ ok: boolean, status?: number, code?: string, message?: string, [key: string]: unknown }>, sessionSubagentsInspect?: (generation: number, body: object) => Promise<{ ok: boolean, status?: number, code?: string, message?: string, [key: string]: unknown }>, sessionSubagentsRefresh?: (generation: number, body: object) => Promise<{ ok: boolean, status?: number, code?: string, message?: string, [key: string]: unknown }> }} [options.control]
 * @param {(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) => import("node:http").Server} [options.createServer] injectable server factory for binding tests
 * @param {(server: import("node:http").Server, options: object, onListening: () => void) => void} [options.listen] injectable listen seam for binding tests
 * @param {(input: string, init?: object) => Promise<Response>} [options.fetch] injectable client fetch seam for binding tests
 * @param {number} [options.selfCheckTimeoutMs] upper bound for one client self-check fetch (default CLIENT_SELF_CHECK_TIMEOUT_MS)
 * @returns {Promise<{ url: string, port: number, token: string, origin: string, close: () => Promise<void>, server: import("node:http").Server, bindingDiagnostics: object }>}
 */
export async function startBridgeServer({
	store,
	assetsDir,
	token = createBridgeToken(),
	port = 0,
	logger = () => {},
	control = NO_LIFECYCLE,
	createServer = createHttpServer,
	listen = (server, options, onListening) => server.listen(options, onListening),
	fetch = globalThis.fetch,
	selfCheckTimeoutMs = CLIENT_SELF_CHECK_TIMEOUT_MS,
}) {
	if (!store || typeof store.snapshot !== "function") {
		throw new Error("startBridgeServer requires a request store");
	}
	if (!assetsDir) {
		throw new Error("startBridgeServer requires an assets directory");
	}

	let expectedHost = null;
	let origin = null;
	const server = createServer((req, res) => {
		handleRequest(req, res).catch((error) => {
			logger(`bridge request failed: ${error?.message ?? error}`);
			if (!res.headersSent) {
				sendError(res, 500, "internal_error", "internal error");
			} else {
				res.destroy();
			}
		});
	});

	let boundPort = null;
	let finalSelfCheck = null;
	const bindingAttempts = [];
	const rebindReasons = [];
	for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt += 1) {
		await listenBridgeServer(server, { host: HOST, port, exclusive: true }, listen);
		const address = server.address();
		if (!address || typeof address === "string") {
			await closeBridgeServer(server);
			throw new Error("bridge server did not bind a TCP port");
		}
		boundPort = address.port;
		expectedHost = `${HOST}:${boundPort}`;
		origin = `http://${expectedHost}`;
		if (isBrowserBlockedPort(boundPort)) {
			bindingAttempts.push({ attempt, port: boundPort, outcome: "browser-blocked", selfCheck: null });
			const blockedMessage = `bridge server selected browser-blocked port ${boundPort} (undici Node fetch + Chromium ERR_UNSAFE_PORT union)`;
			rebindReasons.push({ attempt, port: boundPort, reason: "browser-blocked-port" });
			logger(`${blockedMessage}; closing listener before retry (${attempt}/${MAX_BIND_ATTEMPTS})`);
			await closeBridgeServer(server);
			if (port !== 0) {
				throw new Error(`${blockedMessage}; refusing to publish an unusable URL`);
			}
			if (attempt === MAX_BIND_ATTEMPTS) {
				throw new Error(
					`${blockedMessage}; could not bind a browser-safe ephemeral port after ${MAX_BIND_ATTEMPTS} attempts`,
				);
			}
			continue;
		}

		const selfCheck = await runClientSelfCheck(fetch, boundPort, token, { timeoutMs: selfCheckTimeoutMs });
		bindingAttempts.push({ attempt, port: boundPort, outcome: selfCheck.outcome, selfCheck });
		if (selfCheck.ok) {
			finalSelfCheck = selfCheck;
			logger(
				`bridge client self-check passed for port ${boundPort}` +
					(selfCheck.status === null ? " (HTTP status unavailable)" : ` (HTTP ${selfCheck.status})`),
			);
			break;
		}
		if (selfCheck.outcome === "client-rejected") {
			const rejectionMessage = `bridge client self-check rejected port ${boundPort}: ${selfCheck.error}`;
			rebindReasons.push({ attempt, port: boundPort, reason: "client-rejected-port", detail: selfCheck.error });
			logger(`${rejectionMessage}; closing listener before retry (${attempt}/${MAX_BIND_ATTEMPTS})`);
			await closeBridgeServer(server);
			if (port !== 0) {
				throw new Error(`${rejectionMessage}; refusing to publish an unusable URL`);
			}
			if (attempt === MAX_BIND_ATTEMPTS) {
				throw new Error(
					`${rejectionMessage}; could not bind a browser-safe ephemeral port after ${MAX_BIND_ATTEMPTS} attempts`,
				);
			}
			continue;
		}

		finalSelfCheck = selfCheck;
		logger(`bridge client self-check inconclusive for port ${boundPort}; keeping bound listener: ${selfCheck.error}`);
		break;
	}
	if (boundPort === null) {
		throw new Error("bridge server did not bind a TCP port");
	}
	const url = `${origin}/#t=${token}`;
	const bindingDiagnostics = {
		attempts: bindingAttempts,
		selfCheck: finalSelfCheck,
		selfCheckTimeoutMs,
		rebindReasons,
	};

	// The bridge must never keep the host process alive on its own; Pi owns the lifecycle.
	server.unref();

	async function handleRequest(req, res) {
		if (req.headers.host !== expectedHost) {
			sendError(res, 403, "bad_host", `requests must use Host: ${expectedHost}`);
			return;
		}
		const rawUrl = req.url ?? "/";
		const pathname = rawUrl.split("?")[0];

		if (pathname === "/api/state") {
			if (req.method !== "GET") {
				sendError(res, 405, "method_not_allowed", "use GET for /api/state");
				return;
			}
			if (!authorize(req, res)) {
				return;
			}
			const lifecycle = control.snapshot();
			const chatSince = parseChatSince(rawUrl);
			const session = typeof control.sessionSnapshot === "function" ? control.sessionSnapshot({ chatSince }) : null;
			const sessionPayload = session && typeof session === "object"
				? (Object.prototype.hasOwnProperty.call(session, "chat")
					|| Object.prototype.hasOwnProperty.call(session, "controls")
					|| Object.prototype.hasOwnProperty.call(session, "status")
					|| Object.prototype.hasOwnProperty.call(session, "subagents")
					? session
					: { chat: session })
				: {};
			sendJson(res, 200, {
				ok: true,
				generation: lifecycle.generation,
				reloading: lifecycle.reloading,
				...store.snapshot(),
				...sessionPayload,
			});
			return;
		}

		if (pathname === "/api/reload") {
			if (req.method !== "POST") {
				sendError(res, 405, "method_not_allowed", "use POST for /api/reload");
				return;
			}
			if (!requireSameOrigin(req, res)) {
				return;
			}
			const body = await readJsonRequest(req, res);
			if (!body) {
				return;
			}
			if (!validateExactBody(res, body, POST_BODY_KEYS["/api/reload"], "reload requests must use an empty JSON object")) {
				return;
			}
			logger("browser requested a session reload");
			const result = await control.reload();
			if (!result?.ok) {
				sendError(res, result?.status ?? 409, result?.code ?? "reload_failed", result?.message ?? "reload was refused");
				return;
			}
			sendJson(res, 202, { ok: true, generation: result.generation ?? control.snapshot().generation });
			return;
		}

		if (SUBAGENT_ROUTES.includes(pathname)) {
			if (req.method !== "POST") {
				sendError(res, 405, "method_not_allowed", "use POST for subagent status actions");
				return;
			}
			if (!requireSameOrigin(req, res)) {
				return;
			}
			if (control.snapshot().reloading) {
				sendError(res, 409, "reloading", "the session is reloading; wait for the new generation before acting");
				return;
			}
			const body = await readJsonRequest(req, res);
			if (!body) {
				return;
			}
			if (!validateExactBody(
				res,
				body,
				POST_BODY_KEYS[pathname],
				pathname === "/api/subagents/details"
					? "subagent details only accept generation and id"
					: pathname === "/api/subagents/inspect"
						? "subagent inspection only accepts generation, id, childId and lines"
						: "subagent refresh only accepts generation",
			)) {
				return;
			}
			const lifecycle = control.snapshot();
			if (!Number.isInteger(body.generation) || body.generation < 1) {
				sendError(res, 400, "invalid_generation", "a current integer generation is required");
				return;
			}
			if (body.generation !== lifecycle.generation) {
				sendError(res, 409, "stale_generation", "the browser session generation is no longer current");
				return;
			}
			if (pathname === "/api/subagents/inspect" && !validateInspectBody(res, body)) {
				return;
			}
			const sessionMethod = pathname === "/api/subagents/details"
				? "sessionSubagentsDetails"
				: pathname === "/api/subagents/inspect"
					? "sessionSubagentsInspect"
					: "sessionSubagentsRefresh";
			if (typeof control[sessionMethod] !== "function") {
				sendError(res, 503, "not_attached", "the browser subagent status is not attached to a session");
				return;
			}
			const result = await control[sessionMethod](lifecycle.generation, body);
			if (!result?.ok) {
				if (result?.subagents) {
					sendJson(res, result?.status ?? 503, {
						ok: false,
						error: { code: result?.code ?? "subagents_failed", message: result?.message ?? "the subagent status request failed" },
						subagents: result.subagents,
					});
				} else {
					sendError(res, result?.status ?? 503, result?.code ?? "subagents_failed", result?.message ?? "the subagent status request failed");
				}
				return;
			}
			const { ok: _ok, status: _status, ...payload } = result;
			sendJson(res, 200, { ok: true, ...payload });
			return;
		}

		if (pathname === "/api/answer") {
			if (req.method !== "POST") {
				sendError(res, 405, "method_not_allowed", "use POST for /api/answer");
				return;
			}
			if (!requireSameOrigin(req, res)) {
				return;
			}
			if (control.snapshot().reloading) {
				sendError(res, 409, "reloading", "the session is reloading; wait for the new generation before answering");
				return;
			}
			const body = await readJsonRequest(req, res);
			if (!body) {
				return;
			}
			if (!validateExactBody(res, body, POST_BODY_KEYS["/api/answer"], "answer requests only accept id, action and value")) {
				return;
			}
			const hasValue = Object.prototype.hasOwnProperty.call(body, "value");
			if (body.action === "answer" && !hasValue) {
				sendError(res, 400, "invalid_body", 'answer actions require a "value"');
				return;
			}
			if ((body.action === "cancel" || body.action === "dismiss") && hasValue) {
				sendError(res, 400, "invalid_body", `${body.action} actions must not include "value"`);
				return;
			}
			const result = store.answer(body.id, { action: body.action, value: body.value });
			if (!result.ok) {
				sendError(res, result.status, result.code, result.message);
				return;
			}
			logger(`browser reply: ${result.status} ${result.kind} ${result.id}`);
			sendJson(res, 200, result);
			return;
		}

		if (pathname === "/api/message" || pathname === "/api/stop" || pathname === "/api/model" || pathname === "/api/thinking") {
			if (req.method !== "POST") {
				sendError(res, 405, "method_not_allowed", "use POST for browser session actions");
				return;
			}
			if (!requireSameOrigin(req, res)) {
				return;
			}
			if (control.snapshot().reloading) {
				sendError(res, 409, "reloading", "the session is reloading; wait for the new generation before acting");
				return;
			}
			const body = await readJsonRequest(req, res);
			if (!body) {
				return;
			}
			if (!validateExactBody(
				res,
				body,
				POST_BODY_KEYS[pathname],
				`${pathname.slice("/api/".length)} requests contain an unsupported field`,
			)) {
				return;
			}
			const lifecycle = control.snapshot();
			if (!Number.isInteger(body.generation) || body.generation < 1) {
				sendError(res, 400, "invalid_generation", "a current integer generation is required");
				return;
			}
			if (body.generation !== lifecycle.generation) {
				sendError(res, 409, "stale_generation", "the browser session generation is no longer current");
				return;
			}
			const sessionMethod = pathname === "/api/stop"
				? "sessionStop"
				: pathname === "/api/model"
					? "sessionModel"
					: pathname === "/api/thinking"
						? "sessionThinking"
						: "sessionMessage";
			if (typeof control[sessionMethod] !== "function") {
				sendError(
					res,
					503,
					"not_attached",
					pathname === "/api/model" || pathname === "/api/thinking"
						? "the browser model controls are not attached to a session"
						: "the browser chat is not attached to a session",
				);
				return;
			}
			const result = await control[sessionMethod](lifecycle.generation, body);
			if (!result?.ok) {
				sendError(res, result?.status ?? 503, result?.code ?? "session_action_failed", result?.message ?? "the session action failed");
				return;
			}
			const { ok: _ok, status: _status, ...payload } = result;
			sendJson(res, 200, { ok: true, ...payload });
			return;
		}

		const asset = ASSET_ROUTES[pathname];
		if (!asset) {
			sendError(res, 404, "not_found", "not found");
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			sendError(res, 405, "method_not_allowed", "static assets are read-only");
			return;
		}
		let content;
		try {
			content = await readFile(join(assetsDir, asset));
		} catch {
			sendError(res, 404, "not_found", "asset missing on disk");
			return;
		}
		res.writeHead(200, {
			...SECURITY_HEADERS,
			"Content-Type": CONTENT_TYPES[extname(asset)] ?? "application/octet-stream",
			"Content-Length": content.length,
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		res.end(content);
	}

	/** Token + exact Origin + same-site write checks shared by every POST route. */
	function requireSameOrigin(req, res) {
		if (!authorize(req, res)) {
			return false;
		}
		if (req.headers.origin !== origin) {
			sendError(res, 403, "bad_origin", `write requests must come from ${origin}`);
			return false;
		}
		const fetchSite = req.headers["sec-fetch-site"];
		if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") {
			sendError(res, 403, "bad_fetch_site", "cross-site writes are rejected");
			return false;
		}
		return true;
	}

	/** Reject fields outside one route's explicit JSON body allow-list. */
	function validateExactBody(res, body, allowedKeys, message) {
		const unexpected = Object.keys(body).filter((key) => !allowedKeys.includes(key));
		if (unexpected.length > 0) {
			sendError(res, 400, "invalid_body", message);
			return false;
		}
		return true;
	}

	/**
	 * Type/range checks for the structured inspection body: an async run id and an optional
	 * child node id must be non-empty bounded strings, `lines` must be the same 1..200
	 * integer the extension accepts. The run id is *not* matched against a pattern here —
	 * only the bridge's own generation allow-list decides which ids exist.
	 */
	function validateInspectBody(res, body) {
		if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > INSPECT_LIMITS.maxRunIdChars) {
			sendError(res, 400, "invalid_body", "subagent inspection requires a non-empty async run id");
			return false;
		}
		if (
			body.childId !== undefined
			&& (typeof body.childId !== "string" || body.childId.length === 0 || body.childId.length > INSPECT_LIMITS.maxRunIdChars)
		) {
			sendError(res, 400, "invalid_body", "a child node id must be a non-empty bounded string");
			return false;
		}
		if (
			body.lines !== undefined
			&& (!Number.isInteger(body.lines) || body.lines < INSPECT_LIMITS.minLines || body.lines > INSPECT_LIMITS.maxLines)
		) {
			sendError(res, 400, "invalid_body", `lines must be an integer between ${INSPECT_LIMITS.minLines} and ${INSPECT_LIMITS.maxLines}`);
			return false;
		}
		return true;
	}

	/** Read and validate a JSON object body; returns null after sending an error. */
	async function readJsonRequest(req, res) {
		const contentType = String(req.headers["content-type"] ?? "");
		if (!contentType.toLowerCase().startsWith("application/json")) {
			sendError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return null;
		}
		let body;
		try {
			body = await readJsonBody(req);
		} catch (error) {
			const status = error.code === "body_too_large" ? 413 : 400;
			sendError(res, status, error.code ?? "invalid_json", error.message);
			return null;
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			sendError(res, 400, "invalid_body", "body must be a JSON object");
			return null;
		}
		return body;
	}

	function authorize(req, res) {
		const provided = bearerToken(req);
		if (provided === null) {
			sendError(res, 401, "unauthorized", "missing bearer token");
			return false;
		}
		if (!tokenMatches(token, provided)) {
			sendError(res, 401, "unauthorized", "invalid bearer token");
			return false;
		}
		return true;
	}

	return {
		url,
		port: boundPort,
		origin,
		token,
		server,
		bindingDiagnostics,
		close: () => closeBridgeServer(server),
	};
}
