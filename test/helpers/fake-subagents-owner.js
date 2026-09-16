/**
 * Deterministic fake of the public pi-subagents RPC owner.
 *
 * The real extension registers its owner on the shared extension event bus with
 * `pi.events.on("subagents:rpc:v1:request", …)` and answers on
 * `"subagents:rpc:v1:reply:<requestId>"`. This fixture speaks exactly that public
 * envelope over a fake bus (`createFakeExtensionBus()`), so the host adapter can be driven
 * through the real protocol without a real subagent, a model call or the installed package.
 *
 * It answers only the two read-only methods the host is allowed to send (`ping`, `status`)
 * and records every request, so a test can prove which methods, params and identities were
 * used. Any other method receives the owner's canonical `unsupported_method` error instead
 * of an invented answer.
 */

import {
	SUBAGENT_DETAIL_LINES,
	SUBAGENT_RPC_PROTOCOL_VERSION,
	SUBAGENT_RPC_REPLY_EVENT_PREFIX,
	SUBAGENT_RPC_REQUEST_EVENT,
} from "../../src/core/subagents-rpc.js";

/** A complete public status snapshot: one fleet entry and one running async run. */
export function subagentsStatusData(overrides = {}) {
	return {
		fleet: {
			version: 1,
			entries: [{
				key: "fleet-display-key",
				agent: "reviewer",
				role: "review",
				model: "provider/model",
				effort: "high",
				startedAt: 1700000000000,
				goal: "Review the bounded change",
				tokens: { input: 3, output: 4, total: 7 },
			}],
			totalActive: 1,
			omitted: 0,
		},
		asyncSnapshot: {
			version: 1,
			runs: [{
				id: "async-real-id",
				kind: "subagent",
				state: "running",
				label: "Review",
				goal: "Review the bounded change",
				startedAt: 1700000000000,
				updatedAt: 1700000001000,
				children: [{ id: "child-id", state: "running", label: "Child" }],
			}],
			omitted: { runs: 0, children: 0, byteLimitExceeded: false },
		},
		...overrides,
	};
}

/** The public untargeted status response has no fleet/async data (an owner with no work). */
export function emptySubagentsStatusData() {
	return {
		fleet: { version: 1, entries: [], totalActive: 0, omitted: 0 },
		asyncSnapshot: { version: 1, runs: [], omitted: { runs: 0, children: 0, byteLimitExceeded: false } },
	};
}

/**
 * @param {object} bus fake extension event bus (`createFakeExtensionBus()`)
 * @param {object} [options]
 * @param {((request: object) => object | undefined) | object} [options.status] status reply data;
 *   `undefined` deliberately withholds the reply (timeout case)
 * @returns {object} the owner: recorded `requests`, `methods()`, `targeted()`, `dispose()`
 */
export function createFakeSubagentsOwner(bus, { status = () => subagentsStatusData() } = {}) {
	const requests = [];
	let statusCalls = 0;
	const unsubscribe = bus.on(SUBAGENT_RPC_REQUEST_EVENT, (request) => {
		if (!request || typeof request !== "object") {
			return;
		}
		requests.push(request);
		const reply = (payload) => bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
			version: SUBAGENT_RPC_PROTOCOL_VERSION,
			requestId: request.requestId,
			method: request.method,
			...payload,
		});
		if (request.method === "ping") {
			reply({ success: true, data: { capabilities: { fleetStatus: { version: 1 } } } });
			return;
		}
		if (request.method === "status") {
			statusCalls += 1;
			const data = typeof status === "function" ? status(request) : status;
			if (data === undefined) {
				return;
			}
			reply({ success: true, data });
			return;
		}
		reply({ success: false, error: { code: "unsupported_method", message: `this owner only answers ping/status, not ${String(request.method)}` } });
	});
	return {
		requests,
		get statusCalls() {
			return statusCalls;
		},
		methods: () => requests.map((request) => request.method),
		/** Target transcript requests: a status request carrying a concrete async run id. */
		targeted: () => requests.filter((request) => request.method === "status" && typeof request.params?.id === "string"),
		detailLines: SUBAGENT_DETAIL_LINES,
		dispose() {
			unsubscribe();
		},
	};
}
