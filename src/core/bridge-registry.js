/**
 * Process-owned bridge resources.
 *
 * Reloading extensions replaces every extension instance, so nothing that must
 * outlive a reload (listening server, URL, access token, pending-request store and
 * generation counter) may live in instance state. The registry is a single
 * `globalThis` slot per host process: the reloaded instance adopts the same server,
 * port and token instead of opening a new one, which is what lets the browser keep a
 * working session entry without terminal help.
 *
 * The registry never holds a session ctx, a runner or a UI context: those are
 * generation-scoped and are released with their instance.
 */

const REGISTRY_KEY = Symbol.for("oh-my-pi-gui.bridge-registry.v1");

function emptyRegistry() {
	const registry = {
		server: null,
		store: null,
		generation: 0,
		reloading: false,
		/** Browser-initiated reload scope; remains true until the replacement attach reports success/failure. */
		reloadInFlight: false,
		/** Number and most recent reason for failed generation attach attempts. */
		attachFailures: 0,
		lastAttachError: "",
		urlFile: null,
		log: [],
		/** Set by the currently attached extension instance; reads the live instance. */
		reloadHandler: null,
		/** Current generation-scoped session callbacks; cleared before old ctx/pi can survive reload. */
		sessionControl: null,
		/** Last authoritative subagent snapshot retained while a generation reconnects. */
		subagentsSnapshot: null,
		/** Stable object handed to the HTTP server so route handlers always follow the current instance. */
		control: null,
	};
	const callSession = async (method, generation, body) => {
		const current = getBridgeRegistry();
		if (current.reloading) {
			return { ok: false, status: 409, code: "reloading", message: "the session is reloading; try again after it reconnects" };
		}
		const binding = current.sessionControl;
		if (!binding || typeof binding[method] !== "function") {
			const controls = method === "model" || method === "thinking";
			const subagents = method === "subagentsDetails" || method === "subagentsRefresh";
			return {
				ok: false,
				status: 503,
				code: "not_attached",
				message: controls
					? "the browser model controls are not attached to a session"
					: subagents
						? "the browser subagent status is not attached to a session"
						: "the browser chat is not attached to a session",
			};
		}
		if (generation !== current.generation || binding.generation !== generation) {
			return { ok: false, status: 409, code: "stale_generation", message: "the browser session generation is no longer current" };
		}
		const result = await binding[method](generation, body);
		const after = getBridgeRegistry();
		if (after !== current || after.generation !== generation || after.sessionControl !== binding) {
			return { ok: false, status: 409, code: "stale_generation", message: "the browser session generation changed during the operation" };
		}
		return result;
	};
	registry.control = {
		snapshot() {
			const current = getBridgeRegistry();
			return { generation: current.generation, reloading: current.reloading };
		},
		async reload() {
			const handler = getBridgeRegistry().reloadHandler;
			if (typeof handler !== "function") {
				return { ok: false, status: 503, code: "not_attached", message: "no browser bridge is attached to this session" };
			}
			return handler();
		},
		sessionSnapshot(options = {}) {
			const current = getBridgeRegistry();
			const binding = current.sessionControl;
			if (!binding || binding.generation !== current.generation || typeof binding.snapshot !== "function") {
				const retained = current.subagentsSnapshot;
				return retained
					? { subagents: { ...retained, generation: current.generation } }
					: null;
			}
			try {
				const snapshot = binding.snapshot(options);
				if (snapshot && typeof snapshot === "object" && snapshot.subagents && typeof snapshot.subagents === "object") {
					current.subagentsSnapshot = snapshot.subagents;
				}
				return snapshot;
			} catch {
				return null;
			}
		},
		sessionMessage: (generation, body) => callSession("message", generation, body),
		sessionStop: (generation, body) => callSession("stop", generation, body),
		sessionModel: (generation, body) => callSession("model", generation, body),
		sessionThinking: (generation, body) => callSession("thinking", generation, body),
		sessionSubagentsDetails: (generation, body) => callSession("subagentsDetails", generation, body),
		sessionSubagentsRefresh: (generation, body) => callSession("subagentsRefresh", generation, body),
	};
	return registry;
}

export function getBridgeRegistry() {
	if (!globalThis[REGISTRY_KEY]) {
		globalThis[REGISTRY_KEY] = emptyRegistry();
	}
	return globalThis[REGISTRY_KEY];
}

export function logBridge(entry) {
	const registry = getBridgeRegistry();
	registry.log.push(`${new Date().toISOString()} ${entry}`);
	if (registry.log.length > 60) {
		registry.log.shift();
	}
}

/** Release every process-owned resource. Used for real host quit and explicit stop. */
export function clearBridgeRegistry() {
	globalThis[REGISTRY_KEY] = undefined;
}
