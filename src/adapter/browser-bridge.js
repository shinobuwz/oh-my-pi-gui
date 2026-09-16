/**
 * Browser bridge lifecycle: compatibility gate, process-owned server, UI binding,
 * browser-initiated reload and cleanup.
 *
 * Nothing here runs at extension load time. Each extension instance attaches from
 * `session_start` (or `/browser-ui start`). The listening server, access token and
 * request store live in the process registry so a reload keeps one stable browser
 * entry point: the reloaded instance adopts the same port and token, bumps the
 * binding generation and rejects answers from the previous generation.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clearBridgeRegistry, getBridgeRegistry, logBridge } from "../core/bridge-registry.js";
import { startBridgeServer } from "../core/bridge-server.js";
import { RequestStore } from "../core/request-store.js";
import { checkCompatibility } from "./compat.js";
import { resolveHostPackage } from "./host-package.js";
import { bindBrowserPrompts } from "./ui-adapter.js";
import { captureInfo } from "./runner-capture.js";
import { ChatBridge, clipText, MAX_DELIVERY_ERROR_CHARS } from "./chat-bridge.js";
import { ModelBridge } from "./model-bridge.js";
import { StatusBridge } from "./status-bridge.js";
import { SubagentsBridge } from "./subagents-bridge.js";

/** Host quit reasons that must release every process-owned resource. */
const TERMINAL_SHUTDOWN_REASONS = new Set(["quit"]);

/** How long a browser-initiated reload waits for the session to become idle. */
export const RELOAD_IDLE_MS_ENV = "PI_BROWSER_UI_RELOAD_IDLE_MS";
const DEFAULT_RELOAD_IDLE_MS = 20000;
/** Environment variable that bounds the host's own reload promise. */
export const RELOAD_TIMEOUT_MS_ENV = "PI_BROWSER_UI_RELOAD_TIMEOUT_MS";
export const DEFAULT_RELOAD_TIMEOUT_MS = 45000;

export class CompatibilityError extends Error {
	constructor(message, { errors = [], evidence = null } = {}) {
		super(message);
		this.name = "CompatibilityError";
		this.errors = errors;
		this.evidence = evidence;
	}
}

export class BrowserBridge {
	#assetsDir;
	#logger;
	#env;
	#argv;
	#urlFile;
	#binding = null;
	#chat = null;
	#runnerErrorUnsubscribe = null;
	#deliveryErrorVisibility = false;
	#model = null;
	#status = null;
	#subagents = null;
	#gitExecFile;
	#subagentsOptions;
	#fetch;
	#sessionOwner = Symbol("session-control-binding");
	#host = null;
	#checks = null;
	#starting = null;
	#reloadIdleMs;
	#reloadTimeoutMs;

	constructor({
		assetsDir,
		logger = () => {},
		env = process.env,
		argv = process.argv,
		urlFile = null,
		execFile = undefined,
		fetch = globalThis.fetch,
		subagentsTimeoutMs = undefined,
		subagentsRandomUUID = undefined,
		subagentsSetTimeout = undefined,
		subagentsClearTimeout = undefined,
		subagentsEventDebounceMs = undefined,
	} = {}) {
		this.#assetsDir = assetsDir;
		this.#logger = logger;
		this.#env = env;
		this.#argv = argv;
		this.#urlFile = urlFile;
		this.#fetch = fetch;
		this.#gitExecFile = execFile;
		this.#subagentsOptions = {
			timeoutMs: subagentsTimeoutMs,
			randomUUID: subagentsRandomUUID,
			setTimeout: subagentsSetTimeout,
			clearTimeout: subagentsClearTimeout,
			eventDebounceMs: subagentsEventDebounceMs,
		};
		const configured = Number(env[RELOAD_IDLE_MS_ENV]);
		this.#reloadIdleMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RELOAD_IDLE_MS;
		const configuredTimeout = Number(env[RELOAD_TIMEOUT_MS_ENV]);
		this.#reloadTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
			? configuredTimeout
			: DEFAULT_RELOAD_TIMEOUT_MS;
	}

	get registry() {
		return getBridgeRegistry();
	}

	get store() {
		const registry = this.registry;
		if (!registry.store) {
			registry.store = new RequestStore();
		}
		return registry.store;
	}

	get running() {
		return Boolean(this.registry.server);
	}

	get url() {
		return this.registry.server?.url ?? null;
	}

	get generation() {
		return this.registry.generation;
	}

	#log(message) {
		this.#logger(message);
		logBridge(message);
	}

	/**
	 * Attach this extension instance to the live session: verify the host, adopt or
	 * open the loopback server, and bind the browser bridge through the host's own
	 * prompt lifecycle wrapper. Idempotent within one instance.
	 */
	async attach({ runner, mode = "tui", pi = null, ctx = null }) {
		if (this.#binding) {
			if (pi && ctx && (!this.#chat || !this.#subagents)) {
				this.bindChat({ pi, ctx });
			}
			return this.info();
		}
		if (this.#starting) {
			return this.#starting;
		}
		this.#starting = this.#attachInternal({ runner, mode, pi, ctx })
			.catch((error) => {
				const registry = this.registry;
				registry.attachFailures += 1;
				registry.lastAttachError = error instanceof Error ? error.message : String(error);
				throw error;
			})
			.finally(() => {
				this.#starting = null;
			});
		return this.#starting;
	}

	async #attachInternal({ runner, mode, pi, ctx }) {
		if (mode !== "tui") {
			throw new CompatibilityError(`the browser UI only supports Pi's interactive (tui) mode, not "${mode}"`);
		}
		if (!runner) {
			const capture = captureInfo();
			const attemptedSource = capture.source ? `; last attempted source: ${capture.source}` : "";
			const usedSource = capture.usedSource ? `; used source: ${capture.usedSource}` : "; used source: none";
			const candidateUrl = `; candidate URL: ${capture.candidateUrl ?? "(none)"}`;
			const detail =
				`captured ${capture.captures} bind(s) after ${capture.attempts} candidate attempt(s)${attemptedSource}${usedSource}${candidateUrl}: ` +
				(capture.error ?? "ExtensionRunner.setUIContext was never observed in this process");
			throw new CompatibilityError(
				"the running ExtensionRunner could not be captured; the browser UI refuses to enable instead of falling back to terminal prompts",
				{ errors: [detail] },
			);
		}

		const hostPackage = resolveHostPackage({ env: this.#env, argv: this.#argv });
		if (hostPackage.error) {
			throw new CompatibilityError(hostPackage.error, { errors: hostPackage.attempts });
		}
		const checks = checkCompatibility({ uiContext: runner.getUIContext(), hostPackage });
		this.#checks = checks;
		if (!checks.ok) {
			throw new CompatibilityError(`the browser UI refuses to enable: ${checks.errors.join("; ")}`, {
				errors: checks.errors,
				evidence: { version: checks.version, hostSource: checks.hostSource, fingerprint: checks.fingerprint },
			});
		}

		const registry = this.registry;
		registry.urlFile = registry.urlFile ?? this.#urlFile;
		let adopted = false;
		if (registry.server && registry.server.server?.listening !== false) {
			adopted = true;
		} else {
			registry.server = await startBridgeServer({
				store: this.store,
				assetsDir: this.#assetsDir,
				logger: (message) => this.#log(message),
				control: registry.control,
				fetch: this.#fetch,
			});
			this.#writeUrlFile(registry.server.url);
		}

		// Generation bump happens before rebinding so any prompt created afterwards
		// carries the new generation and answers from the previous one are refused.
		registry.generation += 1;
		this.store.setGeneration(registry.generation);

		const binding = bindBrowserPrompts({ runner, store: this.store, mode, logger: this.#logger });
		if (!binding.ok) {
			if (!adopted) {
				await this.#closeServer();
			}
			throw new CompatibilityError(`the browser UI could not bind Pi's prompt lifecycle: ${binding.errors.join("; ")}`, {
				errors: binding.errors,
			});
		}
		this.#binding = binding;
		this.#host = hostPackage;
		registry.reloadHandler = () => this.requestReload({ runner });
		if (pi && ctx) {
			this.bindChat({ pi, ctx });
		}
		this.#subscribeRunnerErrors(runner, registry.generation);
		// Keep the reload scope active until every generation-scoped binding has
		// completed. A post-bump bind failure must remain visible to requestReload().
		registry.reloading = false;
		registry.reloadInFlight = false;

		this.#log(
			`browser bridge attached (generation ${registry.generation}, ${adopted ? `adopted ${registry.server.origin}` : `listening on ${registry.server.origin}`}, Pi ${hostPackage.version} via ${hostPackage.source})`,
		);
		return this.info();
	}

	/**
	 * End every pending prompt with non-approval and either keep the process-owned
	 * server for the next generation (reload / session replacement) or release it.
	 */
	async detach(reason, { release = false, awaitingReload = !release } = {}) {
		const registry = this.registry;
		const cancelled = this.store.cancelAll(reason);
		this.#unsubscribeRunnerErrors();
		this.#chat?.dispose();
		this.#chat = null;
		this.#model?.dispose();
		this.#model = null;
		this.#status?.dispose();
		this.#status = null;
		if (this.#subagents) {
			registry.subagentsSnapshot = this.#subagents.snapshot();
			this.#subagents.dispose();
		}
		this.#subagents = null;
		if (registry.sessionControl?.owner === this.#sessionOwner) {
			registry.sessionControl = null;
		}
		// Any prompt that still holds the previous UI context must fail explicitly from
		// now on instead of creating requests against a detached bridge.
		this.#binding?.deactivate?.();
		this.#binding = null;
		this.#host = null;
		registry.reloadHandler = null;

		if (release || TERMINAL_SHUTDOWN_REASONS.has(String(reason).replace(/^session_shutdown:/, ""))) {
			registry.reloadInFlight = false;
			await this.#closeServer();
			this.#clearUrlFile();
			clearBridgeRegistry();
			this.#log(`browser bridge released (${reason}); ${cancelled.length} pending prompt(s) ended without approval`);
			return { released: true, cancelled };
		}

		// The server, token and store stay for the next generation; answers to the old
		// generation are refused until it binds (stale ctx references are never reused).
		// Keep a requestReload scope visibly reloading even when the replacement attach
		// fails after its generation bump, until requestReload() reports attach_failed.
		registry.reloading = Boolean(registry.server) && (awaitingReload || registry.reloadInFlight);
		this.#log(
			`browser bridge detached (${reason}); ${cancelled.length} pending prompt(s) ended without approval, waiting for generation ${registry.generation + 1}`,
		);
		return { released: false, cancelled };
	}

	/**
	 * Browser-initiated reload of the current session.
	 *
	 * Runs Pi's own reload entry point through the host's command context: pending
	 * prompts are ended with non-approval first, the session is awaited to idle with a
	 * bound, then `ctx.reload()` runs and the next generation binds itself. The bridge
	 * server, port and token survive, so the page reconnects without a new URL.
	 */
	async requestReload({ runner = null, waitForIdleMs = this.#reloadIdleMs }) {
		const registry = this.registry;
		if (!registry.server) {
			return { ok: false, status: 503, code: "not_attached", message: "the browser bridge is not attached" };
		}
		if (registry.reloading || registry.reloadInFlight) {
			return { ok: false, status: 409, code: "reload_in_progress", message: "a reload is already in progress" };
		}
		const activeRunner = runner ?? null;
		if (!activeRunner || typeof activeRunner.createCommandContext !== "function") {
			return { ok: false, status: 503, code: "runner_unavailable", message: "the running ExtensionRunner is not available" };
		}

		registry.reloading = true;
		registry.reloadInFlight = true;
		const cancelled = this.store.cancelAll("reload");
		this.#log(`browser requested reload: ${cancelled.length} pending prompt(s) ended without approval`);

		let commandContext;
		try {
			commandContext = activeRunner.createCommandContext();
		} catch (error) {
			registry.reloading = false;
			registry.reloadInFlight = false;
			return {
				ok: false,
				status: 503,
				code: "command_context_unavailable",
				message: error instanceof Error ? error.message : String(error),
			};
		}

		try {
			await withTimeout(commandContext.waitForIdle(), waitForIdleMs);
		} catch (error) {
			registry.reloading = false;
			registry.reloadInFlight = false;
			return {
				ok: false,
				status: 409,
				code: "busy",
				message: `the session did not become idle before reloading: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const before = registry.generation;
		const attachFailuresBefore = registry.attachFailures;
		try {
			await withTimeout(commandContext.reload(), this.#reloadTimeoutMs);
		} catch (error) {
			registry.reloading = false;
			registry.reloadInFlight = false;
			if (error?.code === "timeout") {
				return {
					ok: false,
					status: 504,
					code: "reload_timeout",
					message:
						`the host reload did not finish before ${this.#reloadTimeoutMs}ms; it may still complete in the background, so wait for the page to reconnect and confirm the new generation before retrying reload. ` +
						"Reload completion was not confirmed",
				};
			}
			return {
				ok: false,
				status: 500,
				code: "reload_failed",
				message: error instanceof Error ? error.message : String(error),
			};
		}
		const generation = registry.generation;
		if (registry.attachFailures > attachFailuresBefore) {
			registry.reloading = false;
			registry.reloadInFlight = false;
			return {
				ok: false,
				status: 503,
				code: "attach_failed",
				message:
					`the old browser binding was detached, but the new extension instance could not be attached: ${
						registry.lastAttachError || "unknown attach failure"
					}`,
			};
		}
		if (generation <= before) {
			registry.reloading = false;
			registry.reloadInFlight = false;
			return {
				ok: false,
				status: 409,
				code: "reload_refused",
				message: "the host refused to reload (the agent may be streaming or compacting); nothing was changed",
			};
		}
		registry.reloading = false;
		registry.reloadInFlight = false;
		return { ok: true, generation };
	}

	/** Bind current-session chat callbacks to the process-owned server. */
	bindChat({ pi, ctx }) {
		if (!this.#binding) {
			throw new Error("browser chat requires an attached browser bridge");
		}
		this.#chat?.dispose();
		this.#model?.dispose();
		this.#status?.dispose();
		if (this.#subagents) {
			this.registry.subagentsSnapshot = this.#subagents.snapshot();
			this.#subagents.dispose();
		}
		const generation = this.registry.generation;
		const chat = new ChatBridge({ pi, ctx, generation, logger: this.#logger });
		const model = new ModelBridge({ pi, ctx, generation, logger: this.#logger });
		const statusOptions = { ctx, generation, logger: this.#logger };
		if (this.#gitExecFile) {
			statusOptions.execFile = this.#gitExecFile;
		}
		const status = new StatusBridge(statusOptions);
		const subagents = new SubagentsBridge({
			events: pi?.events,
			context: ctx,
			generation,
			logger: this.#logger,
			initialSnapshot: this.registry.subagentsSnapshot,
			...this.#subagentsOptions,
		});
		this.#chat = chat;
		this.#model = model;
		this.#status = status;
		this.#subagents = subagents;
		this.registry.sessionControl = {
			owner: this.#sessionOwner,
			generation,
			snapshot: (options = {}) => ({
			chat: chat.snapshot({ since: options?.chatSince }),
			controls: model.snapshot(),
			status: status.snapshot(),
			subagents: subagents.snapshot(),
		}),
			message: (expectedGeneration, body) => chat.sendMessage(expectedGeneration, body),
			stop: (expectedGeneration, body) => chat.stop(expectedGeneration, body),
			model: (expectedGeneration, body) => model.selectModel(expectedGeneration, body),
			thinking: (expectedGeneration, body) => model.setThinkingLevel(expectedGeneration, body),
			subagentsDetails: (expectedGeneration, body) => subagents.detail(expectedGeneration, body),
			subagentsRefresh: (expectedGeneration, body) => this.#refreshSubagents(expectedGeneration, body, subagents),
		};
		return {
			chat: chat.snapshot(),
			controls: model.snapshot(),
			status: status.snapshot(),
			subagents: subagents.snapshot(),
		};
	}

	/** Subscribe to the host's public asynchronous ExtensionRunner error stream. */
	#subscribeRunnerErrors(runner, generation) {
		this.#unsubscribeRunnerErrors();
		if (typeof runner?.onError !== "function") {
			this.#log(
				"browser UI delivery failure visibility unavailable: the host ExtensionRunner does not expose onError; accepted message delivery failures may not be visible",
			);
			return;
		}
		const listener = (extensionError) => {
			if (extensionError?.event !== "send_user_message") {
				return;
			}
			const rawMessage = extensionError?.error;
			if (typeof rawMessage !== "string" || rawMessage.length === 0) {
				return;
			}
			const message = clipText(rawMessage, MAX_DELIVERY_ERROR_CHARS);
			const chat = this.#chat;
			if (chat?.generation === generation) {
				chat.reportDeliveryError(message);
			}
		};
		try {
			const unsubscribe = runner.onError(listener);
			if (typeof unsubscribe !== "function") {
				this.#log(
					"browser UI delivery failure visibility unavailable: the host ExtensionRunner onError subscription did not provide cleanup",
				);
				return;
			}
			this.#runnerErrorUnsubscribe = () => {
				try {
					unsubscribe();
				} catch (error) {
					this.#log(`could not unsubscribe browser UI delivery errors: ${error instanceof Error ? error.message : String(error)}`);
				}
			};
			this.#deliveryErrorVisibility = true;
		} catch (error) {
			this.#log(
				`browser UI delivery failure visibility unavailable: could not subscribe to the host error stream (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}

	#unsubscribeRunnerErrors() {
		const unsubscribe = this.#runnerErrorUnsubscribe;
		this.#runnerErrorUnsubscribe = null;
		this.#deliveryErrorVisibility = false;
		unsubscribe?.();
	}

	/** Explicit status-only subagent refresh and targeted transcript control. */
	#refreshSubagents(expectedGeneration, body, subagents) {
		if (expectedGeneration !== this.registry.generation || expectedGeneration !== subagents.generation) {
			return Promise.resolve({
				ok: false,
				status: 409,
				code: "stale_generation",
				message: "the browser session generation is no longer current",
			});
		}
		if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "generation")) {
			return Promise.resolve({
				ok: false,
				status: 400,
				code: "invalid_body",
				message: "subagent refresh only accepts the current generation",
			});
		}
		if (body.generation !== expectedGeneration) {
			return Promise.resolve({
				ok: false,
				status: 409,
				code: "stale_generation",
				message: "the browser session generation is no longer current",
			});
		}
		return subagents.refresh().then((snapshot) => {
			if (snapshot.available) {
				return { ok: true, generation: expectedGeneration, subagents: snapshot };
			}
			const error = snapshot.error ?? {
				kind: "unavailable",
				code: "rpc_unavailable",
				message: "pi-subagents in-process RPC is unavailable",
			};
			const status = error.code === "timeout" ? 504 : error.kind === "rpc_error" || error.kind === "invalid_reply" ? 502 : 503;
			return {
				ok: false,
				status,
				code: error.code,
				message: error.message,
				subagents: snapshot,
			};
		});
	}

	/** Forward public session events to the current generation's session controls. */
	handleSessionEvent(event, ctx) {
		this.#chat?.handle(event, ctx);
		this.#model?.handle(event, ctx);
		this.#status?.handle(event, ctx);
	}

	/** Explicit `/browser-ui stop`: hand the host its own context back and release resources. */
	async stop(reason = "stop") {
		const registry = this.registry;
		const wasRunning = Boolean(registry.server);
		this.#binding?.restore();
		const { cancelled } = await this.detach(reason, { release: true });
		return { stopped: wasRunning, cancelled };
	}

	/** Status report; `uiContext` (from a fresh ctx) is checked against the live binding. */
	info({ uiContext = null } = {}) {
		const registry = this.registry;
		const binding = this.#binding
			? this.#binding.verifyBinding(uiContext ?? undefined)
			: { ok: false, reason: "not attached to this extension instance" };
		const pending = this.store.snapshot().pending;
		return {
			running: Boolean(registry.server),
			url: registry.server?.url ?? null,
			port: registry.server?.port ?? null,
			generation: registry.generation,
			reloading: registry.reloading,
			revision: this.store.revision,
			pending: pending.length,
			pendingIds: pending.map((request) => request.id),
			hostVersion: this.#host?.version ?? this.#checks?.version ?? null,
			hostSource: this.#host?.source ?? null,
			checks: this.#checks ? { ok: this.#checks.ok, errors: this.#checks.errors } : null,
			binding: { attached: Boolean(this.#binding), ...binding },
			deliveryErrorVisibility: this.#deliveryErrorVisibility,
			urlFile: registry.urlFile,
			bindingDiagnostics: registry.server?.bindingDiagnostics ?? null,
		};
	}

	/** Tail of the process-shared bridge log (survives reload). */
	logTail(count = 5) {
		return this.registry.log.slice(-count);
	}

	async #closeServer() {
		const registry = this.registry;
		const server = registry.server;
		registry.server = null;
		if (server) {
			await server.close();
		}
	}

	#writeUrlFile(url) {
		const urlFile = this.registry.urlFile;
		if (!urlFile) {
			return;
		}
		try {
			mkdirSync(dirname(urlFile), { recursive: true });
			writeFileSync(urlFile, `${url}\n`, { encoding: "utf8", mode: 0o600 });
		} catch (error) {
			this.#log(`could not write the bridge URL file: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#clearUrlFile() {
		const urlFile = this.registry.urlFile;
		if (!urlFile) {
			return;
		}
		try {
			rmSync(urlFile, { force: true });
		} catch {
			// best effort cleanup only
		}
	}
}

function withTimeout(promise, ms) {
	if (!Number.isFinite(ms) || ms <= 0) {
		return promise;
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms}ms`), { code: "timeout" })), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
