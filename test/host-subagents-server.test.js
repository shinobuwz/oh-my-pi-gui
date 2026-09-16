/**
 * Host → browser read-only subagents slice over real HTTP.
 *
 * `startHost` is driven with a fake SDK that exposes the public extension-bus surface, so
 * the host attaches the real `HostSubagentsBridge` over its own fake event bus and a fake
 * pi-subagents RPC owner answers the real public envelope. The two fixed routes
 * (`POST /api/subagents/details`, `POST /api/subagents/refresh`) and the `/api/state`
 * `subagents` section are exercised through the loopback server with its token, Host,
 * Origin and exact-body-key checks — no model call, no real subagent, no installed package.
 *
 * The HTTP client is `node:http` on purpose, matching the other host server tests.
 */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CHILD_STATUS_EVENT,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REQUEST_EVENT,
} from "../src/core/subagents-rpc.js";
import { startHost } from "../src/host/host.js";
import { createFakeSdk } from "./helpers/fake-sdk.js";
import { createFakeSubagentsOwner, emptySubagentsStatusData, subagentsStatusData } from "./helpers/fake-subagents-owner.js";

const stubFetch = async () => ({ status: 200 });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic read-only Git double so the status panel never depends on the machine. */
function gitStub(branch = "main") {
	return (file, args, options, callback) => {
		queueMicrotask(() => callback(null, `${branch}\n`, ""));
		return { kill: () => {} };
	};
}

const HINT_CHANNELS = [SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_CHILD_STATUS_EVENT, SUBAGENT_RPC_READY_EVENT];

/**
 * Start a host whose SDK exposes the public extension-bus surface. `setup` runs before
 * `startHost` and receives the fixture, so a fake RPC owner can be registered while the host
 * boots — exactly the timing of the real extension, which registers during resource load.
 */
async function withHost(run, { extensionBus = true, timeoutMs, eventDebounceMs, logger = () => {}, setup = null } = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-gui-subagents-"));
	const { sdk, bus, calls } = createFakeSdk({ extensionBus });
	const extra = typeof setup === "function" ? await setup({ sdk, bus, calls, tmp }) : {};
	const host = await startHost({
		cwd: tmp,
		urlFile: join(tmp, "url"),
		env: {},
		sdk,
		fetch: stubFetch,
		print: () => {},
		logger,
		statusExecFile: gitStub(),
		...(timeoutMs ? { subagentsTimeoutMs: timeoutMs } : {}),
		...(eventDebounceMs !== undefined ? { subagentsEventDebounceMs: eventDebounceMs } : {}),
	});
	try {
		return await run({ host, tmp, bus, calls, sdk, ...extra });
	} finally {
		await host.close("test");
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Raw loopback HTTP client; the bridge never sees a browser proxy here. */
function request(host, path, { method = "GET", headers = {}, body } = {}) {
	return new Promise((resolvePromise, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port: host.port, path, method, headers }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let payload = {};
				try {
					payload = JSON.parse(text);
				} catch {
					payload = { raw: text };
				}
				resolvePromise({ status: res.statusCode, payload });
			});
		});
		req.on("error", reject);
		if (body !== undefined) {
			req.write(JSON.stringify(body));
		}
		req.end();
	});
}

function authHeaders(host, extra = {}) {
	return { Authorization: `Bearer ${host.bridge.token}`, ...extra };
}

function getState(host) {
	return request(host, "/api/state", { headers: authHeaders(host) });
}

function post(host, path, body, extraHeaders = {}) {
	return request(host, path, {
		method: "POST",
		headers: authHeaders(host, { Origin: host.origin, "Content-Type": "application/json", ...extraHeaders }),
		body,
	});
}

describe("SDK host subagents over HTTP", () => {
	it("serves the bounded read-only slice and round-trips both fixed routes", async () => {
		const transcripts = [];
		await withHost(async ({ host, calls, owner, bus }) => {
			await host.subagents.bind();

			// The host owns the SDK's event bus and hands the same bus to the resource loader,
			// so every loaded extension (including pi-subagents) shares it.
			assert.equal(calls.resourceReloads, 1, "the caller-provided loader is reloaded exactly once");
			assert.equal(calls.created.length, 1);
			assert.equal(calls.created[0].resourceLoader, calls.resourceLoaderInstances[0], "the session must use the channel loader");
			assert.equal(calls.resourceLoaders[0].eventBus, bus);

			const state = await getState(host);
			assert.equal(state.status, 200);
			const subagents = state.payload.subagents;
			assert.equal(subagents.available, true);
			assert.equal(subagents.state, "ready-data");
			assert.equal(subagents.generation, 1);
			assert.equal(subagents.fleet.entries.length, 1);
			assert.equal(subagents.fleet.entries[0].key, "fleet-display-key");
			assert.equal(subagents.asyncSnapshot.runs[0].id, "async-real-id");
			assert.equal(subagents.asyncSnapshot.runs[0].updatedAt, 1700000001000);
			assert.equal("lastUpdate" in subagents.asyncSnapshot.runs[0], false);

			// A fleet display key is not a run id: the route refuses it without asking the owner.
			const viaFleetKey = await post(host, "/api/subagents/details", { generation: 1, id: "fleet-display-key" });
			assert.equal(viaFleetKey.status, 404);
			assert.equal(viaFleetKey.payload.error.code, "not_found");
			assert.equal(owner.targeted().length, 0, "no targeted RPC may be sent for a fleet key");

			const detail = await post(host, "/api/subagents/details", { generation: 1, id: "async-real-id" });
			assert.equal(detail.status, 200);
			assert.equal(detail.payload.ok, true);
			assert.equal(detail.payload.id, "async-real-id");
			assert.deepEqual(transcripts, [{ id: "async-real-id", view: "transcript", lines: 80 }], "the detail request uses the fixed bounded transcript view");
			assert.match(detail.payload.text, /Bearer \[redacted\]/);
			assert.match(detail.payload.text, /key=\[redacted\]/);
			assert.equal(detail.payload.text.includes("secret-token"), false);
			assert.equal(detail.payload.text.includes("sk-live-1"), false);
			assert.match(detail.payload.text, /\/tmp\/ordinary\.txt/, "ordinary path text stays readable");
			assert.equal(detail.payload.summary.id, "async-real-id");
			assert.equal(detail.payload.summary.results[0].agent, "reviewer");
			assert.equal("task" in detail.payload.summary.results[0], false, "raw task fields must not cross the boundary");

			// Refresh is status-only and the page keeps the last honest snapshot on failure.
			const beforeRefresh = owner.statusCalls;
			const refreshed = await post(host, "/api/subagents/refresh", { generation: 1 });
			assert.equal(refreshed.status, 200);
			assert.equal(refreshed.payload.ok, true);
			assert.equal(refreshed.payload.generation, 1);
			assert.equal(refreshed.payload.subagents.state, "ready-empty");
			assert.equal(owner.statusCalls, beforeRefresh + 1, "refresh sends exactly one untargeted status");
			assert.deepEqual(owner.requests.at(-1).params, {});
			assert.equal(owner.targeted().length, 1, "refresh must never target a run");

			const afterRefresh = await getState(host);
			assert.equal(afterRefresh.payload.subagents.state, "ready-empty");
			assert.equal(afterRefresh.payload.subagents.asyncSnapshot.runs.length, 0);
		}, {
			setup: ({ bus }) => {
				let statusCalls = 0;
				return {
					owner: createFakeSubagentsOwner(bus, {
						status: (rpc) => {
							if (rpc.params?.id) {
								transcripts.push(rpc.params);
								return {
									text: "state: running\nBearer secret-token\n/tmp/ordinary.txt\nbudget key=sk-live-1",
									details: { results: [{ index: 0, agent: "reviewer", success: true, task: "must not be forwarded" }] },
								};
							}
							statusCalls += 1;
							// The owner finishes its work between the initial bind and the explicit refresh.
							return statusCalls === 1 ? subagentsStatusData() : emptySubagentsStatusData();
						},
					}),
				};
			},
		});
	});

	it("coalesces public async hints into one status refresh", async () => {
		await withHost(async ({ host, bus, owner }) => {
			await host.subagents.bind();
			const before = owner.statusCalls;
			bus.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "not-rendered" });
			bus.emit(SUBAGENT_CHILD_STATUS_EVENT, { id: "not-rendered" });
			bus.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "not-rendered" });
			await wait(300);
			assert.equal(owner.statusCalls, before + 1, "a hint burst must become exactly one status refresh");
			const state = await getState(host);
			assert.equal(state.payload.subagents.state, "ready-data");
		}, {
			eventDebounceMs: 20,
			setup: ({ bus }) => ({ owner: createFakeSubagentsOwner(bus) }),
		});
	});

	it("rejects unauthenticated, cross-site, wrong-host, extra-field and stale requests before the owner", async () => {
		await withHost(async ({ host, owner }) => {
			await host.subagents.bind();
			const seen = owner.requests.length;

			const unauthenticated = await request(host, "/api/subagents/refresh", {
				method: "POST",
				headers: { Origin: host.origin, "Content-Type": "application/json" },
				body: { generation: 1 },
			});
			assert.equal(unauthenticated.status, 401);
			assert.equal(unauthenticated.payload.error.code, "unauthorized");

			const wrongHost = await request(host, "/api/state", { headers: { ...authHeaders(host), Host: "localhost" } });
			assert.equal(wrongHost.status, 403);

			const crossSite = await post(host, "/api/subagents/details", { generation: 1, id: "async-real-id" }, { Origin: "https://evil.example" });
			assert.equal(crossSite.status, 403);
			assert.equal(crossSite.payload.error.code, "bad_origin");

			const extraField = await post(host, "/api/subagents/details", { generation: 1, id: "async-real-id", view: "transcript" });
			assert.equal(extraField.status, 400);
			assert.equal(extraField.payload.error.code, "invalid_body");

			const extraRefreshField = await post(host, "/api/subagents/refresh", { generation: 1, id: "not-accepted" });
			assert.equal(extraRefreshField.status, 400);
			assert.equal(extraRefreshField.payload.error.code, "invalid_body");

			const stale = await post(host, "/api/subagents/refresh", { generation: 2 });
			assert.equal(stale.status, 409);
			assert.equal(stale.payload.error.code, "stale_generation");

			const wrongMethod = await request(host, "/api/subagents/refresh", { headers: authHeaders(host) });
			assert.equal(wrongMethod.status, 405);

			assert.equal(owner.requests.length, seen, "no refused request may reach the pi-subagents RPC owner");
		}, { setup: ({ bus }) => ({ owner: createFakeSubagentsOwner(bus) }) });
	});

	it("reports an attached but unanswered owner honestly instead of inventing data", async () => {
		await withHost(async ({ host }) => {
			// No RPC owner at all: exactly the case where pi-subagents is not installed. The
			// adapter is attached (the host owns the bus), the ping times out and the panel must
			// say so rather than show fabricated rows.
			const settled = await host.subagents.bind();
			assert.equal(settled.error.code, "timeout");
			const state = await getState(host);
			assert.equal(state.payload.subagents.available, false);
			assert.equal(state.payload.subagents.error.code, "timeout");
			assert.deepEqual(state.payload.subagents.fleet.entries, []);
			assert.deepEqual(state.payload.subagents.asyncSnapshot.runs, []);
			assert.equal(host.subagents.active, true);

			const detail = await post(host, "/api/subagents/details", { generation: 1, id: "async-real-id" });
			assert.equal(detail.status, 404);
			assert.equal(detail.payload.error.code, "not_found");

			const refreshed = await post(host, "/api/subagents/refresh", { generation: 1 });
			assert.equal(refreshed.status, 504);
			assert.equal(refreshed.payload.error.code, "timeout");
			assert.equal(refreshed.payload.subagents.available, false, "the failure still carries the snapshot for the page");
			assert.equal(refreshed.payload.subagents.error.code, "timeout");
		}, { timeoutMs: 40 });
	});

	it("stays unattached with an explicit reason when the host shape has no extension event bus", async () => {
		const logs = [];
		await withHost(async ({ host, calls }) => {
			assert.equal(calls.resourceLoaders.length, 0, "without the public bus surface the host must not build its own loader");
			assert.equal(host.subagents, null);
			const state = await getState(host);
			assert.equal("subagents" in state.payload, false, "an unattached panel must not appear as a fabricated section");
			const refreshed = await post(host, "/api/subagents/refresh", { generation: 1 });
			assert.equal(refreshed.status, 503);
			assert.equal(refreshed.payload.error.code, "not_attached");
			const details = await post(host, "/api/subagents/details", { generation: 1, id: "async-real-id" });
			assert.equal(details.status, 503);
			assert.equal(details.payload.error.code, "not_attached");
		}, { extensionBus: false, logger: (message) => logs.push(message) });
		assert.equal(
			logs.some((line) => line.includes("the read-only pi-subagents panel stays unattached")),
			true,
			"the reason must be logged instead of silently dropped",
		);
	});

	it("refuses to start when the session resources cannot be loaded", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-gui-subagents-"));
		const urlFile = join(tmp, "url");
		const { sdk, calls, bus } = createFakeSdk({ extensionBus: true, resourceLoaderError: new Error("extension load exploded") });
		let busClears = 0;
		const originalClear = bus.clear;
		bus.clear = () => {
			busClears += 1;
			return originalClear.call(bus);
		};
		const lines = [];
		try {
			await assert.rejects(
				startHost({
					cwd: tmp,
					urlFile,
					env: {},
					sdk,
					fetch: stubFetch,
					print: (line) => lines.push(line),
					statusExecFile: gitStub(),
				}),
				(error) => {
					assert.equal(error.stage, "resources");
					assert.match(error.message, /could not load the session resources/);
					assert.match(error.message, /extension load exploded/);
					return true;
				},
			);
			assert.match(lines[0] ?? "", /^Pi GUI host listening: /, "the URL is published before extensions load");
			assert.doesNotMatch(lines.join("\n"), /^Pi GUI host ready$/m);
			assert.equal(existsSync(urlFile), false, "a failed start must withdraw the URL file");
			assert.equal(calls.resourceReloads, 1);
			assert.equal(calls.created.length, 0, "the session is never created when its resources cannot be loaded");
			assert.equal(busClears, 1, "a failed start must release the shared extension event bus");
			assert.deepEqual(bus.channels(), []);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("stops writing to the extension bus after shutdown", async () => {
		await withHost(async ({ host, bus, owner }) => {
			await host.subagents.bind();
			const running = bus.emittedOn(SUBAGENT_RPC_REQUEST_EVENT).length;
			assert.equal(running > 0, true, "the attached adapter performs its initial read-only bind");
			bus.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "not-rendered" });
			await wait(300);
			assert.equal(bus.emittedOn(SUBAGENT_RPC_REQUEST_EVENT).length > running, true, "a hint refresh writes to the bus while the host runs");

			const closed = await host.close("test");
			assert.deepEqual(closed.errors, []);
			assert.equal(host.subagents.active, false);
			const afterClose = bus.emittedOn(SUBAGENT_RPC_REQUEST_EVENT).length;
			const afterCloseRequests = owner.requests.length;
			bus.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "not-rendered" });
			await wait(60);
			assert.equal(bus.emittedOn(SUBAGENT_RPC_REQUEST_EVENT).length, afterClose, "a closed host must not send another read-only RPC");
			assert.equal(owner.requests.length, afterCloseRequests);
			assert.deepEqual(bus.channels().filter((channel) => HINT_CHANNELS.includes(channel)), [], "shutdown drops the hint subscriptions");
			assert.equal(bus.channels().length, 0, "shutdown clears the shared extension event bus");
		}, {
			eventDebounceMs: 20,
			setup: ({ bus }) => ({ owner: createFakeSubagentsOwner(bus) }),
		});
	});

	it("releases the adapter and the shared bus on the synchronous exit path", async () => {
		await withHost(async ({ host, bus, owner }) => {
			await host.subagents.bind();
			host.exitCleanup();
			assert.equal(host.subagents.active, false);
			assert.deepEqual(bus.channels().filter((channel) => HINT_CHANNELS.includes(channel)), []);
			const emitted = bus.emittedOn(SUBAGENT_RPC_REQUEST_EVENT).length;
			const ownerRequests = owner.requests.length;
			bus.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "not-rendered" });
			await wait(60);
			assert.equal(bus.emittedOn(SUBAGENT_RPC_REQUEST_EVENT).length, emitted, "the exit path must not leave a subscriber that writes to the bus");
			assert.equal(owner.requests.length, ownerRequests);
			const closed = await host.close("after-exit");
			assert.deepEqual(closed.errors, []);
		}, {
			eventDebounceMs: 20,
			setup: ({ bus }) => ({ owner: createFakeSubagentsOwner(bus) }),
		});
	});
});
