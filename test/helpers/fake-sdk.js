/**
 * Recording fake for the public SDK entry points the host uses.
 *
 * The host must create a new session for the requested cwd, bind our UI context with
 * `mode: "tui"`, drive the browser chat through the public `AgentSession` surface
 * (`prompt`/`abort`/`subscribe`/`isIdle`/`isStreaming`/`sessionManager`), drive the
 * model/thinking controls through the public `AgentSession` surface
 * (`model`/`thinkingLevel`/`scopedModels`/`modelRuntime.getAvailableSnapshot()`/
 * `getAvailableThinkingLevels()`/`setModel()`/`setThinkingLevel()`) and read the status panel
 * through `sessionManager.getCwd()`/`getBranch()` and `getContextUsage()`. Tests assert those
 * exact calls without a model or a real installation.
 *
 * The fake session stays fully deterministic: `prompt()` records the call and does not run a
 * model, `emit()` delivers a synthetic `AgentSessionEvent` to every subscriber, and the phase
 * flags, model fields and usage entries are plain values the test drives. The fixture models
 * deliberately carry credential-shaped fields (`apiKey`, `headers`, `baseUrl`) so a leakage
 * test can prove they never reach the browser.
 */

import { THINKING_LEVELS } from "../../src/core/model-catalog.js";

/**
 * Fixture for the shared extension event bus (`EventBus`) the SDK hands to `pi.events`.
 *
 * It records every channel subscription and emission so a test can prove which channels the
 * host subscribed to, replay a fake pi-subagents RPC owner, or check that shutdown dropped
 * every handler. The shape is the documented public one: `on(channel, handler)` returns an
 * unsubscribe function, `emit(channel, data)` delivers synchronously, and `clear()` (the
 * SDK's `EventBusController`) drops every subscription.
 */
export function createFakeExtensionBus() {
	const handlers = new Map();
	const emitted = [];
	return {
		handlers,
		emitted,
		emit(channel, payload) {
			emitted.push({ channel, payload });
			for (const handler of [...(handlers.get(channel) ?? [])]) {
				handler(payload);
			}
		},
		on(channel, handler) {
			if (!handlers.has(channel)) {
				handlers.set(channel, new Set());
			}
			handlers.get(channel).add(handler);
			return () => handlers.get(channel)?.delete(handler);
		},
		clear() {
			handlers.clear();
		},
		/** Channels with at least one live subscription. */
		channels() {
			return [...handlers.entries()].filter(([, set]) => set.size > 0).map(([channel]) => channel);
		},
		emittedOn(channel) {
			return emitted.filter((entry) => entry.channel === channel);
		},
	};
}

/** Fixture model with display fields plus deliberately unsafe provider configuration. */
export function fixtureModel(provider, id, name, extra = {}) {
	return {
		provider,
		id,
		name,
		reasoning: true,
		contextWindow: 128000,
		maxTokens: 8192,
		baseUrl: `https://${provider}.private.invalid/v1`,
		headers: { Authorization: "Bearer should-not-leak" },
		apiKey: "should-not-leak",
		...extra,
	};
}

const DEFAULT_MODEL_A = fixtureModel("fixture", "model-a", "Fixture model A");
const DEFAULT_MODEL_B = fixtureModel("fixture", "model-b", "Fixture model B", { reasoning: false });

/**
 * @param {object} [options]
 * @param {Error | null} [options.bindError] reject `bindExtensions`
 * @param {Error | null} [options.createError] reject `createAgentSession`
 * @param {string | null} [options.sessionFile] reported session file
 * @param {boolean} [options.idle] initial `session.isIdle`
 * @param {Array<object>} [options.entries] active-branch entries returned by the session manager
 * @param {((text: string, options: object) => unknown) | null} [options.prompt] optional prompt implementation
 * @param {object | null} [options.model] current model (`null` = not yet selected)
 * @param {Array<object> | null} [options.availableModels] `modelRuntime.getAvailableSnapshot()` result; `null` omits the runtime
 * @param {Array<object>} [options.scopedModels] session scoped models
 * @param {string} [options.thinkingLevel] initial thinking level
 * @param {string[]} [options.availableThinkingLevels] levels `getAvailableThinkingLevels()` reports
 * @param {object | undefined} [options.contextUsage] `getContextUsage()` result
 * @param {Error | null} [options.modelChangeError] thrown by `setModel()`
 * @param {Error | null} [options.thinkingChangeError] thrown by `setThinkingLevel()`
 * @param {string | null} [options.thinkingClampTo] level `setThinkingLevel()` clamps every request to
 * @param {boolean} [options.extensionBus] also expose the public SDK surface for the shared
 *   extension event bus (`createEventBus`/`DefaultResourceLoader`/`SettingsManager`/`getAgentDir`),
 *   so `src/host/host.js` attaches the read-only subagents adapter
 * @param {Error | null} [options.resourceLoaderError] rejected by the fake `DefaultResourceLoader.reload()`
 * @returns {{ sdk: object, calls: object, session: object, sessionManager: object, listeners: Set<Function>, bus: object | null }}
 */
export function createFakeSdk({
	bindError = null,
	createError = null,
	sessionFile = null,
	idle = true,
	entries = [],
	prompt = null,
	model = DEFAULT_MODEL_A,
	availableModels = [DEFAULT_MODEL_A, DEFAULT_MODEL_B],
	scopedModels = [],
	thinkingLevel = "medium",
	availableThinkingLevels = [...THINKING_LEVELS],
	contextUsage = undefined,
	modelChangeError = null,
	thinkingChangeError = null,
	thinkingClampTo = null,
	extensionBus = false,
	resourceLoaderError = null,
} = {}) {
	const calls = {
		managers: [],
		created: [],
		bound: [],
		disposed: 0,
		prompts: [],
		aborts: 0,
		subscriptions: 0,
		unsubscriptions: 0,
		modelChanges: [],
		thinkingChanges: [],
		eventBuses: [],
		settingsManagers: [],
		resourceLoaders: [],
		resourceLoaderInstances: [],
		resourceReloads: 0,
	};
	const listeners = new Set();
	const sessionManager = {
		cwd: null,
		sessionDir: null,
		getCwd: () => sessionManager.cwd,
		getSessionFile: () => sessionFile,
		buildContextEntries: () => entries,
		getBranch: () => entries,
		getEntries: () => entries,
		getLeafId: () => entries.at(-1)?.id ?? null,
	};
	const session = {
		sessionManager,
		/** Mutable session phase; tests flip these instead of running a model. */
		isIdle: idle,
		isStreaming: !idle,
		pendingMessageCount: 0,
		/** Public model/thinking state the browser controls read. */
		model,
		thinkingLevel,
		scopedModels,
		modelRuntime: availableModels === null ? null : { getAvailableSnapshot: () => availableModels },
		getAvailableThinkingLevels: () => [...availableThinkingLevels],
		getContextUsage: () => contextUsage,
		/** Public command/extension accessors the browser slash-command catalog reads. */
		extensionRunner: null,
		promptTemplates: [],
		resourceLoader: null,
		/** Optional prompt implementation; a throw or rejection is surfaced as a delivery error. */
		onPrompt: prompt,
		prompt(text, options) {
			calls.prompts.push({ text, options });
			if (typeof this.onPrompt === "function") {
				try {
					return Promise.resolve(this.onPrompt(text, options));
				} catch (error) {
					return Promise.reject(error);
				}
			}
			return Promise.resolve();
		},
		abort() {
			calls.aborts += 1;
			return Promise.resolve();
		},
		/** Public model action: records the call, honors the configured failure and applies the model. */
		setModel(next, options) {
			calls.modelChanges.push({ model: next, options });
			if (modelChangeError) {
				return Promise.reject(modelChangeError);
			}
			session.model = next;
			return Promise.resolve(true);
		},
		/** Public thinking action: records the call and applies the configured clamp. */
		setThinkingLevel(level, options) {
			calls.thinkingChanges.push({ level, options });
			if (thinkingChangeError) {
				throw thinkingChangeError;
			}
			session.thinkingLevel = thinkingClampTo ?? level;
		},
		subscribe(listener) {
			calls.subscriptions += 1;
			listeners.add(listener);
			return () => {
				calls.unsubscriptions += 1;
				listeners.delete(listener);
			};
		},
		/** Deliver one synthetic session event to the current subscribers. */
		emit(event) {
			for (const listener of [...listeners]) {
				listener(event);
			}
		},
		bindExtensions(bindings) {
			calls.bound.push(bindings);
			return bindError ? Promise.reject(bindError) : Promise.resolve();
		},
		dispose() {
			calls.disposed += 1;
		},
	};
	const sdk = {
		SessionManager: {
			create(cwd, sessionDir, options) {
				calls.managers.push({ cwd, sessionDir, options });
				sessionManager.cwd = cwd;
				sessionManager.sessionDir = sessionDir;
				return sessionManager;
			},
		},
		createAgentSession(options) {
			calls.created.push(options);
			if (createError) {
				return Promise.reject(createError);
			}
			session.sessionManager = options?.sessionManager ?? sessionManager;
			return Promise.resolve({ session, extensionsResult: { extensions: [] } });
		},
	};
	const bus = extensionBus ? createFakeExtensionBus() : null;
	if (extensionBus) {
		const agentDir = "C:/fixture/agent";
		sdk.createEventBus = () => {
			calls.eventBuses.push(bus);
			return bus;
		};
		sdk.getAgentDir = () => agentDir;
		sdk.SettingsManager = {
			create(cwd, directory) {
				calls.settingsManagers.push({ cwd, agentDir: directory });
				return { cwd, agentDir: directory };
			},
		};
		sdk.DefaultResourceLoader = class FakeDefaultResourceLoader {
			constructor(options) {
				calls.resourceLoaders.push(options);
				calls.resourceLoaderInstances.push(this);
				this.options = options;
			}
			async reload() {
				calls.resourceReloads += 1;
				if (resourceLoaderError) {
					throw resourceLoaderError;
				}
			}
			getExtensions() {
				return { extensions: [], errors: [], runtime: {} };
			}
		};
	}
	return { sdk, calls, session, sessionManager, listeners, bus };
}
