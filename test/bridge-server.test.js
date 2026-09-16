/**
 * Loopback transport behaviour over real HTTP: authentication, Host/Origin checks,
 * size limits, static asset allow-list, reconnect replay of pending ids and
 * duplicate reply rejection.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { BROWSER_BLOCKED_PORTS, CLIENT_SELF_CHECK_TIMEOUT_MS, isBrowserBlockedPort, startBridgeServer } from "../src/core/bridge-server.js";
import { LIMITS, RequestStore } from "../src/core/request-store.js";

const ASSETS_DIR = fileURLToPath(new URL("../src/browser/", import.meta.url));

/**
 * Reference port tables copied from the two clients this guard stands in for:
 * - the WHATWG fetch "bad port" list as implemented by undici/Node fetch (every
 *   entry below is also re-verified against the running Node client in the test),
 * - Chromium's `ERR_UNSAFE_PORT` additions that are not part of the fetch list.
 * The production table must equal the item-by-item union of both, so deleting or
 * altering any entry fails this suite instead of only a sampled few.
 */
const UNDICI_BAD_PORTS = Object.freeze([
	1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
	101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
	389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
	587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
	5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const CHROMIUM_UNSAFE_PORT_EXTRAS = Object.freeze([138]);

let store;
let bridge;

before(async () => {
	store = new RequestStore();
	bridge = await startBridgeServer({ store, assetsDir: ASSETS_DIR });
});

after(async () => {
	await bridge?.close();
});

const authHeaders = () => ({ Authorization: `Bearer ${bridge.token}` });

async function rawRequest(path, { method = "GET", headers = {}, body } = {}) {
	const { request } = await import("node:http");
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: bridge.port,
				path,
				method,
				headers,
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		if (body !== undefined) {
			req.write(body);
		}
		req.end();
	});
}

function scriptedServer(ports) {
	let address = null;
	let index = 0;
	let closeCalls = 0;
	const listeners = new Map();
	const listenCalls = [];
	return {
		listenCalls,
		get closeCalls() {
			return closeCalls;
		},
		once(event, listener) {
			listeners.set(event, listener);
		},
		removeListener(event, listener) {
			if (listeners.get(event) === listener) {
				listeners.delete(event);
			}
		},
		listen(options, callback) {
			listenCalls.push(options);
			address = { address: options.host, port: ports[index++] };
			callback();
		},
		address() {
			return address;
		},
		close(callback) {
			closeCalls += 1;
			address = null;
			callback?.();
		},
		unref() {},
		closeAllConnections() {},
	};
}

describe("bridge binding", () => {
	it("matches the full reference browser-blocked port union item by item", async () => {
		assert.deepEqual(
			[...BROWSER_BLOCKED_PORTS],
			[...BROWSER_BLOCKED_PORTS].sort((a, b) => a - b),
			"the published table must stay sorted so the reference comparison is meaningful",
		);
		assert.equal(
			new Set(BROWSER_BLOCKED_PORTS).size,
			BROWSER_BLOCKED_PORTS.length,
			"the published table must not contain duplicate entries",
		);
		const expected = [...new Set([...UNDICI_BAD_PORTS, ...CHROMIUM_UNSAFE_PORT_EXTRAS])].sort((a, b) => a - b);
		assert.deepEqual(
			[...BROWSER_BLOCKED_PORTS],
			expected,
			"a deleted, altered or added port entry must fail this item-by-item comparison",
		);
		for (const port of BROWSER_BLOCKED_PORTS) {
			assert.equal(isBrowserBlockedPort(port), true, `port ${port} must be reported as browser-blocked`);
		}
		for (const port of [80, 443, 2000, 3000, 8443, 49152]) {
			assert.equal(isBrowserBlockedPort(port), false, `port ${port} must stay allowed`);
		}
		// Ground the reference table in the running client: every undici entry is
		// rejected before any connection attempt (no listener is needed here).
		for (const port of UNDICI_BAD_PORTS) {
			await assert.rejects(
				() => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }),
				(error) => {
					const detail = `${error?.message ?? ""} ${error?.cause?.message ?? ""} ${error?.cause?.code ?? error?.code ?? ""}`;
					assert.match(
						detail,
						/bad port|ERR_UNSAFE_PORT/i,
						`port ${port} must be rejected by the running client as a bad port before connecting`,
					);
					return true;
				},
			);
		}
		// The Chromium-only extra is not in the fetch list, so it cannot be verified
		// against Node fetch; it must still stay in the published table.
		assert.equal(isBrowserBlockedPort(138), true, "the Chromium ERR_UNSAFE_PORT extra must stay in the table");
	});

	it("rebinds an ephemeral browser-blocked port before publishing the URL", async () => {
		for (const port of [77, 113, 115, 117, 4190, 6679, 10080]) {
			assert.equal(isBrowserBlockedPort(port), true, `port ${port} must be treated as browser-blocked`);
		}
		assert.equal(isBrowserBlockedPort(6000), true);
		assert.equal(isBrowserBlockedPort(6566), true);
		assert.equal(isBrowserBlockedPort(6667), true);
		assert.equal(isBrowserBlockedPort(138), true);
		assert.equal(isBrowserBlockedPort(80), false);
		assert.equal(isBrowserBlockedPort(443), false);
		assert.equal(isBrowserBlockedPort(8443), false);

		const fake = scriptedServer([6000, 8443]);
		const bridge = await startBridgeServer({
			store: new RequestStore(),
			assetsDir: ASSETS_DIR,
			token: "a".repeat(64),
			createServer: () => fake,
			listen: (server, options, onListening) => server.listen(options, onListening),
			fetch: async () => ({ status: 200 }),
		});
		try {
			assert.equal(bridge.port, 8443);
			assert.equal(bridge.origin, "http://127.0.0.1:8443");
			assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:8443\/#t=a{64}$/);
			assert.equal(fake.listenCalls.length, 2);
			assert.deepEqual(fake.listenCalls.map((options) => ({ host: options.host, port: options.port, exclusive: options.exclusive })), [
				{ host: "127.0.0.1", port: 0, exclusive: true },
				{ host: "127.0.0.1", port: 0, exclusive: true },
			]);
			assert.equal(fake.closeCalls, 1, "the blocked listener must be closed before retrying");
		} finally {
			await bridge.close();
		}
		assert.equal(fake.closeCalls, 2, "the accepted listener must still be closed by the caller");
	});

	it("rebinds after a bad-port client self-check and publishes only after the next check succeeds", async () => {
		const token = "b".repeat(64);
		const fake = scriptedServer([8443, 9000]);
		const fetchCalls = [];
		const logs = [];
		const clientFetch = async (url, options) => {
			fetchCalls.push({ url, options });
			if (fetchCalls.length === 1) {
				throw new TypeError("fetch failed", { cause: new Error("bad port") });
			}
			return { status: 401 };
		};
		const bridge = await startBridgeServer({
			store: new RequestStore(),
			assetsDir: ASSETS_DIR,
			token,
			logger: (message) => logs.push(message),
			createServer: () => fake,
			listen: (server, options, onListening) => server.listen(options, onListening),
			fetch: clientFetch,
		});
		try {
			assert.equal(bridge.port, 9000);
			assert.equal(fetchCalls.length, 2);
			assert.deepEqual(fetchCalls.map(({ url }) => url), [
				"http://127.0.0.1:8443/api/state",
				"http://127.0.0.1:9000/api/state",
			]);
			assert.deepEqual(fetchCalls[0].options.headers, { Authorization: `Bearer ${token}` });
			assert.equal(fetchCalls[0].options.redirect, "manual", "the self-check must not follow redirects away from loopback");
			assert.ok(fetchCalls[0].options.signal instanceof AbortSignal, "the self-check request must carry an abort bound");
			assert.equal(fake.closeCalls, 1, "a client-rejected listener must be closed before retrying");
			assert.equal(bridge.bindingDiagnostics.selfCheck.status, 401, "any HTTP response proves client reachability");
			assert.deepEqual(bridge.bindingDiagnostics.rebindReasons, [
				{ attempt: 1, port: 8443, reason: "client-rejected-port", detail: "fetch failed; cause: bad port" },
			]);
			assert.match(logs.join("\n"), /client self-check rejected port 8443/);
			assert.match(logs.join("\n"), /client self-check passed for port 9000/);
			assert.equal(logs.join("\n").includes(token), false, "self-check diagnostics must not leak the bearer token");
		} finally {
			await bridge.close();
		}
	});

	it("keeps a bound listener after an ordinary client self-check network error", async () => {
		const fake = scriptedServer([9001]);
		const logs = [];
		const networkError = new Error("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
		});
		const bridge = await startBridgeServer({
			store: new RequestStore(),
			assetsDir: ASSETS_DIR,
			logger: (message) => logs.push(message),
			createServer: () => fake,
			listen: (server, options, onListening) => server.listen(options, onListening),
			fetch: async () => { throw networkError; },
		});
		try {
			assert.equal(bridge.port, 9001);
			assert.equal(fake.listenCalls.length, 1, "ordinary network failures must not trigger a rebind");
			assert.equal(fake.closeCalls, 0);
			assert.deepEqual(bridge.bindingDiagnostics.rebindReasons, []);
			assert.equal(bridge.bindingDiagnostics.selfCheck.outcome, "network-error");
			assert.equal(bridge.bindingDiagnostics.selfCheck.timedOut, false);
			assert.equal(
				bridge.bindingDiagnostics.selfCheckTimeoutMs,
				CLIENT_SELF_CHECK_TIMEOUT_MS,
				"the default self-check bound must be the published finite constant",
			);
			assert.match(logs.join("\n"), /self-check inconclusive.*ECONNREFUSED/);
		} finally {
			await bridge.close();
		}
	});

	it("treats a production ERR_UNSAFE_PORT code as client-rejected even without bad-port text", async () => {
		const fake = scriptedServer([9003, 9004]);
		const fetchCalls = [];
		const logs = [];
		const clientFetch = async (url) => {
			fetchCalls.push(url);
			if (fetchCalls.length === 1) {
				throw new TypeError("fetch failed", {
					cause: Object.assign(new Error("client rejected the selected port"), { code: "ERR_UNSAFE_PORT" }),
				});
			}
			return { status: 200 };
		};
		const bridge = await startBridgeServer({
			store: new RequestStore(),
			assetsDir: ASSETS_DIR,
			logger: (message) => logs.push(message),
			createServer: () => fake,
			listen: (server, options, onListening) => server.listen(options, onListening),
			fetch: clientFetch,
		});
		try {
			assert.equal(bridge.port, 9004, "a code-only client rejection must trigger a rebind");
			assert.equal(fetchCalls.length, 2);
			assert.equal(fake.closeCalls, 1, "the client-rejected listener must be closed before retrying");
			assert.deepEqual(
				bridge.bindingDiagnostics.rebindReasons.map(({ attempt, port, reason }) => ({ attempt, port, reason })),
				[{ attempt: 1, port: 9003, reason: "client-rejected-port" }],
			);
			assert.match(bridge.bindingDiagnostics.rebindReasons[0].detail, /client rejected the selected port/);
			assert.equal(
				bridge.bindingDiagnostics.rebindReasons[0].detail.includes("bad port"),
				false,
				"the rejection must come from the code branch, not from bad-port text",
			);
			assert.match(logs.join("\n"), /client self-check rejected port 9003/);
		} finally {
			await bridge.close();
		}
	});

	it("bounds a client self-check fetch that never settles and keeps the bound listener", async () => {
		const fake = scriptedServer([9010]);
		const token = "e".repeat(64);
		const logs = [];
		const fetchOptions = [];
		const neverSettles = new Promise(() => {});
		const started = Date.now();
		let guardTimer = null;
		const bridge = await Promise.race([
			startBridgeServer({
				store: new RequestStore(),
				assetsDir: ASSETS_DIR,
				token,
				selfCheckTimeoutMs: 250,
				logger: (message) => logs.push(message),
				createServer: () => fake,
				listen: (server, options, onListening) => server.listen(options, onListening),
				fetch: (url, options) => {
					fetchOptions.push({ url, options });
					return neverSettles;
				},
			}),
			new Promise((_, reject) => {
				guardTimer = setTimeout(
					() => reject(new Error("a client self-check fetch that never settles must not hang startBridgeServer")),
					5000,
				);
			}),
		]).finally(() => clearTimeout(guardTimer));
		const elapsed = Date.now() - started;
		try {
			assert.ok(elapsed >= 250, `the self-check must wait for its bounded timeout (took ${elapsed}ms)`);
			assert.ok(elapsed < 5000, `the self-check must not hang startup (took ${elapsed}ms)`);
			assert.equal(bridge.port, 9010);
			assert.equal(bridge.origin, "http://127.0.0.1:9010");
			assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:9010\/#t=e{64}$/, "the URL must still be published");
			assert.equal(fake.listenCalls.length, 1, "a timed-out self-check must keep the already bound listener");
			assert.equal(fake.closeCalls, 0, "a timed-out self-check must not close the listener");
			assert.deepEqual(bridge.bindingDiagnostics.rebindReasons, []);
			assert.equal(bridge.bindingDiagnostics.selfCheck.outcome, "inconclusive");
			assert.equal(bridge.bindingDiagnostics.selfCheck.timedOut, true);
			assert.equal(bridge.bindingDiagnostics.selfCheck.port, 9010);
			assert.match(bridge.bindingDiagnostics.selfCheck.error, /did not settle within 250ms/);
			assert.equal(bridge.bindingDiagnostics.attempts.length, 1);
			assert.equal(bridge.bindingDiagnostics.attempts[0].outcome, "inconclusive");
			assert.equal(bridge.bindingDiagnostics.attempts[0].port, 9010);
			assert.equal(bridge.bindingDiagnostics.attempts[0].selfCheck, bridge.bindingDiagnostics.selfCheck);
			assert.equal(fetchOptions.length, 1);
			assert.equal(fetchOptions[0].url, "http://127.0.0.1:9010/api/state");
			assert.deepEqual(fetchOptions[0].options.headers, { Authorization: `Bearer ${token}` });
			assert.equal(fetchOptions[0].options.redirect, "manual");
			assert.ok(fetchOptions[0].options.signal instanceof AbortSignal);
			assert.match(logs.join("\n"), /self-check inconclusive.*did not settle within 250ms/);
		} finally {
			await bridge.close();
		}
	});

	it("redacts the bearer token from self-check diagnostics, logs and the thrown fail-closed error", async () => {
		const token = "f".repeat(64);
		const fake = scriptedServer([9005, 9006]);
		const logs = [];
		let calls = 0;
		const clientFetch = async () => {
			calls += 1;
			if (calls === 1) {
				throw new TypeError("fetch failed", {
					cause: Object.assign(new Error(`client rejected the port for token ${token}`), { code: "ERR_UNSAFE_PORT" }),
				});
			}
			return { status: 200 };
		};
		const bridge = await startBridgeServer({
			store: new RequestStore(),
			assetsDir: ASSETS_DIR,
			token,
			logger: (message) => logs.push(message),
			createServer: () => fake,
			listen: (server, options, onListening) => server.listen(options, onListening),
			fetch: clientFetch,
		});
		try {
			const diagnostics = JSON.stringify(bridge.bindingDiagnostics);
			assert.equal(diagnostics.includes(token), false, "binding diagnostics must not contain the bearer token");
			assert.match(diagnostics, /\[redacted\]/, "the redaction marker must be visible in diagnostics");
			assert.equal(logs.join("\n").includes(token), false, "self-check logs must not leak the bearer token");
			assert.match(logs.join("\n"), /\[redacted\]/);
		} finally {
			await bridge.close();
		}

		// Fail-closed rebinding must not leak the token through the thrown error either.
		const exhausted = scriptedServer(Array.from({ length: 10 }, () => 9007));
		await assert.rejects(
			() => startBridgeServer({
				store: new RequestStore(),
				assetsDir: ASSETS_DIR,
				token,
				createServer: () => exhausted,
				listen: (server, options, onListening) => server.listen(options, onListening),
				fetch: async () => {
					throw new TypeError("fetch failed", {
						cause: Object.assign(new Error(`unsafe port for token ${token}`), { code: "ERR_UNSAFE_PORT" }),
					});
				},
			}),
			(error) => {
				assert.equal(String(error.message).includes(token), false, "the thrown self-check error must not leak the bearer token");
				assert.match(String(error.message), /\[redacted\]/);
				return true;
			},
		);
	});

	it("fails closed when every client self-check reports a rejected port", async () => {
		const fake = scriptedServer(Array.from({ length: 10 }, () => 9002));
		const token = "c".repeat(64);
		const logs = [];
		await assert.rejects(
			() => startBridgeServer({
				store: new RequestStore(),
				assetsDir: ASSETS_DIR,
				token,
				logger: (message) => logs.push(message),
				createServer: () => fake,
				listen: (server, options, onListening) => server.listen(options, onListening),
				fetch: async () => { throw new TypeError("fetch failed", { cause: new Error("unsafe port") }); },
			}),
			/could not bind a browser-safe ephemeral port after 10 attempts/,
		);
		assert.equal(fake.listenCalls.length, 10);
		assert.equal(fake.closeCalls, 10, "every client-rejected listener must be closed without publishing a URL");
		assert.equal(logs.join("\n").includes(token), false, "failed self-check diagnostics must not leak the bearer token");
	});

	it("fails closed after exhausting browser-safe ephemeral bind attempts", async () => {
		const fake = scriptedServer(Array.from({ length: 10 }, () => 6000));
		await assert.rejects(
			() => startBridgeServer({
				store: new RequestStore(),
				assetsDir: ASSETS_DIR,
				createServer: () => fake,
				listen: (server, options, onListening) => server.listen(options, onListening),
			}),
			/could not bind a browser-safe ephemeral port after 10 attempts/,
		);
		assert.equal(fake.listenCalls.length, 10);
		assert.equal(fake.closeCalls, 10, "every rejected listener must be closed without publishing a URL");
	});
});

describe("bridge transport security", () => {
	it("binds loopback with an unpredictable token in the URL fragment", () => {
		assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}$/);
		assert.equal(bridge.port > 0, true);
		assert.equal(bridge.origin, `http://127.0.0.1:${bridge.port}`);
	});

	it("serves the local page with a strict CSP and no external resources", async () => {
		const response = await rawRequest("/");
		assert.equal(response.status, 200);
		assert.match(response.headers["content-security-policy"], /default-src 'none'/);
		assert.equal(response.headers["cache-control"], "no-store");
		assert.equal(response.headers["x-content-type-options"], "nosniff");
		assert.equal(response.headers["referrer-policy"], "no-referrer");
	});

	it("only serves allow-listed assets", async () => {
		assert.equal((await rawRequest("/app.js")).status, 200);
		assert.equal((await rawRequest("/app.css")).status, 200);
		assert.equal((await rawRequest("/package.json")).status, 404);
		assert.equal((await rawRequest("/%2e%2e/package.json")).status, 404);
		assert.equal((await rawRequest("/../package.json")).status, 404);
		assert.equal((await rawRequest("/api/unknown")).status, 404);
	});

	it("rejects requests whose Host header is not the bound loopback authority", async () => {
		const response = await rawRequest("/api/state", { headers: { ...authHeaders(), Host: "evil.example" } });
		assert.equal(response.status, 403);
		assert.equal(JSON.parse(response.text).error.code, "bad_host");
	});

	it("requires the bearer token for API reads", async () => {
		const missing = await rawRequest("/api/state");
		assert.equal(missing.status, 401);
		const wrong = await rawRequest("/api/state", { headers: { Authorization: "Bearer deadbeef" } });
		assert.equal(wrong.status, 401);
		const ok = await rawRequest("/api/state", { headers: authHeaders() });
		assert.equal(ok.status, 200);
	});

	it("rejects cross-site writes even with a valid token", async () => {
		const { id } = store.create({ kind: "confirm" });
		const noOrigin = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({ id, action: "answer", value: true }),
		});
		assert.equal(noOrigin.status, 403);
		const badOrigin = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: "https://evil.example" },
			body: JSON.stringify({ id, action: "answer", value: true }),
		});
		assert.equal(badOrigin.status, 403);
		assert.equal(JSON.parse(badOrigin.text).error.code, "bad_origin");
		const crossSite = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin, "Sec-Fetch-Site": "cross-site" },
			body: JSON.stringify({ id, action: "answer", value: true }),
		});
		assert.equal(crossSite.status, 403);
		// None of the rejected writes may answer the request.
		assert.equal(store.isPending(id), true);
		store.cancelAll("test");
	});

	it("requires a JSON content type on writes", async () => {
		const { id } = store.create({ kind: "confirm" });
		const response = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "text/plain", Origin: bridge.origin },
			body: JSON.stringify({ id, action: "answer", value: true }),
		});
		assert.equal(response.status, 415);
		store.cancelAll("test");
	});

	it("rejects oversized bodies and invalid JSON", async () => {
		const { id } = store.create({ kind: "input" });
		const oversized = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body: JSON.stringify({ id, action: "answer", value: "x".repeat(LIMITS.maxBodyBytes + 10) }),
		});
		assert.equal(oversized.status, 413);
		assert.equal(JSON.parse(oversized.text).error.code, "body_too_large");
		const invalid = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body: "{not json",
		});
		assert.equal(invalid.status, 400);
		assert.equal(JSON.parse(invalid.text).error.code, "invalid_json");
		store.cancelAll("test");
	});

	it("accepts the maximum editor text in ASCII and multi-byte UTF-8 bodies", async () => {
		for (const value of ["a".repeat(LIMITS.editorChars), "界".repeat(LIMITS.editorChars)]) {
			const { id, promise } = store.create({ kind: "editor" });
			const response = await rawRequest("/api/answer", {
				method: "POST",
				headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
				body: JSON.stringify({ id, action: "answer", value }),
			});
			assert.equal(response.status, 200);
			assert.equal((await promise).length, LIMITS.editorChars);
		}
	});

	it("rejects a request body above the 320 KiB transport limit", async () => {
		const { id } = store.create({ kind: "editor" });
		const response = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body: JSON.stringify({ id, action: "answer", value: "x".repeat(320 * 1024) }),
		});
		assert.equal(response.status, 413);
		assert.equal(JSON.parse(response.text).error.code, "body_too_large");
		store.cancelAll("test");
	});

	it("rejects wrong methods and unknown API paths", async () => {
		assert.equal((await rawRequest("/api/state", { method: "POST", headers: authHeaders() })).status, 405);
		assert.equal((await rawRequest("/api/message", { method: "GET", headers: authHeaders() })).status, 405);
		assert.equal((await rawRequest("/", { method: "POST" })).status, 405);
		const unknown = await rawRequest("/api/not-a-route", { method: "POST", headers: authHeaders() });
		assert.equal(unknown.status, 404);
		assert.equal(JSON.parse(unknown.text).error.code, "not_found");
	});

	it("enforces exact reload and answer body shapes", async () => {
		const { id } = store.create({ kind: "confirm" });
		const reload = await rawRequest("/api/reload", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body: JSON.stringify({ ignored: true }),
		});
		assert.equal(reload.status, 400);
		assert.equal(JSON.parse(reload.text).error.code, "invalid_body");

		const extra = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body: JSON.stringify({ id, action: "answer", value: true, ignored: true }),
		});
		assert.equal(extra.status, 400);
		assert.equal(JSON.parse(extra.text).error.code, "invalid_body");
		assert.equal(store.isPending(id), true, "rejected answer extras must not resolve the host request");

		const missingValue = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body: JSON.stringify({ id, action: "answer" }),
		});
		assert.equal(missingValue.status, 400);
		assert.equal(JSON.parse(missingValue.text).error.code, "invalid_body");
		assert.equal(store.isPending(id), true);

		const valueOnCancel = await rawRequest("/api/answer", {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body: JSON.stringify({ id, action: "cancel", value: false }),
		});
		assert.equal(valueOnCancel.status, 400);
		assert.equal(JSON.parse(valueOnCancel.text).error.code, "invalid_body");
		store.cancelAll("test");
	});
});

describe("bridge prompt round trip", () => {
	it("delivers a browser answer to the waiting host request", async () => {
		const { id, promise } = store.create({ kind: "select", title: "Pick", options: ["one", "two"] });
		const snapshot = await (await fetch(`${bridge.origin}/api/state`, { headers: authHeaders() })).json();
		const pending = snapshot.pending.find((request) => request.id === id);
		assert.equal(pending.title, "Pick");
		assert.deepEqual(pending.options, ["one", "two"]);

		const answer = await fetch(`${bridge.origin}/api/answer`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body: JSON.stringify({ id, action: "answer", value: "two" }),
		});
		assert.equal(answer.status, 200);
		assert.equal(await promise, "two");
	});

	it("replays the same pending id to a reconnecting client", async () => {
		const { id, promise } = store.create({ kind: "confirm", title: "Reconnect" });
		const first = await (await fetch(`${bridge.origin}/api/state`, { headers: authHeaders() })).json();
		await new Promise((resolve) => setTimeout(resolve, 50));
		// A brand new client (new connection) sees the same request id.
		const second = await (await fetch(`${bridge.origin}/api/state`, { headers: authHeaders() })).json();
		assert.equal(first.pending.find((request) => request.id === id).id, id);
		assert.equal(second.pending.find((request) => request.id === id).id, id);
		assert.ok(second.revision >= first.revision);
		store.answer(id, { action: "cancel" });
		assert.equal(await promise, false);
		assert.equal((await (await fetch(`${bridge.origin}/api/state`, { headers: authHeaders() })).json()).pending.length, 0);
	});

	it("rejects duplicate and stale replies without touching the host flow", async () => {
		const { id, promise } = store.create({ kind: "confirm" });
		const body = JSON.stringify({ id, action: "answer", value: true });
		const first = await fetch(`${bridge.origin}/api/answer`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body,
		});
		assert.equal(first.status, 200);
		const second = await fetch(`${bridge.origin}/api/answer`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json", Origin: bridge.origin },
			body,
		});
		assert.equal(second.status, 409);
		assert.equal((await second.json()).error.code, "already_resolved");
		assert.equal(await promise, true);
	});

	it("keeps prompt text as data (the page renders it as text)", async () => {
		const payload = "<img src=x onerror=alert(1)> & <script>alert(2)</script>";
		const { id, promise } = store.create({ kind: "confirm", title: payload, message: payload });
		const snapshot = await (await fetch(`${bridge.origin}/api/state`, { headers: authHeaders() })).json();
		const pending = snapshot.pending.find((request) => request.id === id);
		assert.equal(pending.title, payload);
		assert.equal(pending.message, payload);
		store.cancelAll("test");
		assert.equal(await promise, false);
	});
});
