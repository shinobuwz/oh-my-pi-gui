/**
 * SDK GUI host: create an agent session with the public Pi SDK, expose it to the
 * browser through the loopback bridge, and own its lifecycle.
 *
 * The host process owns the session: it is created here, bound to our
 * `ExtensionUIContext`, served to the browser, and released when the process exits.
 * It never attaches to another Pi process, never modifies user settings/credentials,
 * and never falls back to terminal interaction: any startup failure is reported and
 * the process exits.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { notAttached } from "../core/chat-messages.js";
import { startBridgeServer } from "../core/bridge-server.js";
import { RequestStore } from "../core/request-store.js";
import { HostChatBridge } from "./chat.js";
import { HostModelBridge } from "./models.js";
import { loadHostSdk, missingSdkExports } from "./sdk-loader.js";
import { HostStatusBridge } from "./status.js";
import { HostSubagentsBridge, openSubagentsChannel } from "./subagents.js";

/** Comma/semicolon separated extra extension paths for this GUI session. */
export const EXTRA_EXTENSIONS_ENV = "PI_GUI_EXTRA_EXTENSIONS";
import { createBrowserUIContext } from "./ui-context.js";

/** Unbundled page sources; tests and the no-build fallback serve these directly. */
export const DEFAULT_ASSETS_DIR = fileURLToPath(new URL("../browser/", import.meta.url));
/** Vite output served by `npm start` after `vite build`. */
export const BUILT_ASSETS_DIR = fileURLToPath(new URL("../../dist/browser/", import.meta.url));
/** Default URL file, relative to the invoker's working directory. */
export const DEFAULT_URL_FILE = ".browser-ui/url";
/** Single binding generation: the GUI owns one session per process and never rebinds in place. */
export const HOST_GENERATION = 1;
/**
 * Extension mode for `session.bindExtensions()`.
 *
 * `rpc` keeps every dialog capability (`confirm` / `select` / `input` / `editor` still land
 * in the browser — Pi's contract gives rpc the same dialog surface as tui and `hasUI()`
 * only depends on a UI context being provided), and it unlocks pi-subagents' host inspect
 * command `/subagents-inspect-rpc`, which refuses to emit its structured reply on tui
 * surfaces (`ctx.mode === "tui"` gate).
 *
 * Known, accepted cost: extensions that gate themselves on `ctx.mode !== "tui"`
 * (questionnaire, Pi's llama extension) take their non-interactive branch and report their
 * own failure text; the host renders that text as-is and never hangs or fakes an answer.
 */
export const HOST_UI_MODE = "rpc";

/** Startup failure with the resolution attempts that led to it. */
export class HostStartupError extends Error {
	constructor(message, { stage, attempts = [], cause = null } = {}) {
		super(message, cause ? { cause } : undefined);
		this.name = "HostStartupError";
		this.stage = stage;
		this.attempts = attempts;
	}
}

/** Public `AgentSession` members the browser chat drives. Missing members fail the start closed. */
export const REQUIRED_SESSION_MEMBERS = Object.freeze(["prompt", "abort", "subscribe"]);
/** Public `SessionManager` member used as the history source. */
export const REQUIRED_SESSION_MANAGER_MEMBERS = Object.freeze(["buildContextEntries"]);
/** Public `AgentSession` actions the browser model/thinking controls drive. */
export const REQUIRED_MODEL_MEMBERS = Object.freeze(["setModel", "setThinkingLevel"]);

/**
 * Report the public session actions the browser model/thinking controls require. The status
 * panel degrades to explicit unknowns, so it has no fail-closed members of its own.
 */
export function missingModelMembers(session) {
	const missing = [];
	if (!session || typeof session !== "object") {
		return ["session"];
	}
	for (const member of REQUIRED_MODEL_MEMBERS) {
		if (typeof session[member] !== "function") {
			missing.push(member);
		}
	}
	return missing;
}

/**
 * Report the public session members the browser chat requires and the session does not
 * provide, so a changed SDK shape is refused at startup instead of degrading silently.
 */
export function missingSessionMembers(session) {
	const missing = [];
	if (!session || typeof session !== "object") {
		return ["session"];
	}
	for (const member of REQUIRED_SESSION_MEMBERS) {
		if (typeof session[member] !== "function") {
			missing.push(member);
		}
	}
	if (typeof session.isIdle !== "boolean") {
		missing.push("isIdle");
	}
	if (typeof session.isStreaming !== "boolean") {
		missing.push("isStreaming");
	}
	const sessionManager = session.sessionManager;
	if (!sessionManager || typeof sessionManager !== "object") {
		missing.push("sessionManager");
	} else {
		for (const member of REQUIRED_SESSION_MANAGER_MEMBERS) {
			if (typeof sessionManager[member] !== "function") {
				missing.push(`sessionManager.${member}`);
			}
		}
	}
	return missing;
}

/**
 * Lifecycle control object for the bridge. There is no in-place reload: the GUI owns its
 * session process, so a reload request is refused with an explicit reason instead of
 * pretending a new generation exists. The chat and read-only subagents adapters are attached
 * once the SDK session is bound; the model/thinking and status adapters are attached as soon
 * as the session exists, so a page opened during extension binding already shows them. Until
 * an adapter is attached, its routes report `not_attached` and `/api/state` carries no section
 * for it.
 */
export function createHostLifecycle({ generation = HOST_GENERATION } = {}) {
	let chat = null;
	let model = null;
	let status = null;
	let subagents = null;
	const notAttachedModel = () => ({
		ok: false,
		status: 503,
		code: "not_attached",
		message: "the browser model controls are not attached to a session",
	});
	const notAttachedThinking = () => ({
		ok: false,
		status: 503,
		code: "not_attached",
		message: "the browser thinking controls are not attached to a session",
	});
	const notAttachedSubagents = () => ({
		ok: false,
		status: 503,
		code: "not_attached",
		message: "the browser subagent status is not attached to a session",
	});
	return {
		snapshot: () => ({ generation, reloading: false }),
		reload: async () => ({
			ok: false,
			status: 501,
			code: "reload_unavailable",
			message: "this GUI owns its own agent session; restart the host process instead of reloading it in place",
		}),
		/** Attach the session's chat adapter; returns it for inspection. */
		attachChat(adapter) {
			chat = adapter;
			return chat;
		},
		/** Detach and return the current chat adapter without disposing it. */
		detachChat() {
			const current = chat;
			chat = null;
			return current;
		},
		/** Attach the session's model/thinking adapter; returns it for inspection. */
		attachModel(adapter) {
			model = adapter;
			return model;
		},
		detachModel() {
			const current = model;
			model = null;
			return current;
		},
		/** Attach the session's status adapter; returns it for inspection. */
		attachStatus(adapter) {
			status = adapter;
			return status;
		},
		detachStatus() {
			const current = status;
			status = null;
			return current;
		},
		/** Attach the session's read-only subagents adapter; returns it for inspection. */
		attachSubagents(adapter) {
			subagents = adapter;
			return subagents;
		},
		detachSubagents() {
			const current = subagents;
			subagents = null;
			return current;
		},
		/** `/api/state`: only the sections whose adapter is attached. */
		sessionSnapshot: (options = {}) => {
			const snapshot = {};
			if (chat) {
				snapshot.chat = chat.snapshot({ since: options?.chatSince });
			}
			if (model) {
				snapshot.controls = model.snapshot();
			}
			if (status) {
				snapshot.status = status.snapshot();
			}
			if (subagents) {
				snapshot.subagents = subagents.snapshot();
			}
			return Object.keys(snapshot).length > 0 ? snapshot : null;
		},
		sessionMessage: (expectedGeneration, body) => (chat ? chat.sendMessage(expectedGeneration, body) : Promise.resolve(notAttached())),
		sessionStop: (expectedGeneration, body) => (chat ? chat.stop(expectedGeneration, body) : Promise.resolve(notAttached())),
		sessionModel: (expectedGeneration, body) => (model
			? model.selectModel(expectedGeneration, body)
			: Promise.resolve(notAttachedModel())),
		sessionThinking: (expectedGeneration, body) => (model
			? model.setThinkingLevel(expectedGeneration, body)
			: Promise.resolve(notAttachedThinking())),
		sessionSubagentsDetails: (expectedGeneration, body) => (subagents
			? subagents.details(expectedGeneration, body)
			: Promise.resolve(notAttachedSubagents())),
		sessionSubagentsInspect: (expectedGeneration, body) => (subagents
			? subagents.inspect(expectedGeneration, body)
			: Promise.resolve(notAttachedSubagents())),
		sessionSubagentsSession: (expectedGeneration, body) => (subagents
			? subagents.session(expectedGeneration, body)
			: Promise.resolve(notAttachedSubagents())),
		sessionSubagentsRefresh: (expectedGeneration, body) => (subagents
			? subagents.refresh(expectedGeneration, body)
			: Promise.resolve(notAttachedSubagents())),
	};
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function readSessionFile(session) {
	try {
		const file = session?.sessionManager?.getSessionFile?.();
		return typeof file === "string" && file.length > 0 ? file : null;
	} catch {
		return null;
	}
}

/**
 * Start the GUI host.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] session working directory (default: process.cwd())
 * @param {string | null} [options.urlFile] URL file path; `null` disables the file
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(message: string) => void} [options.logger]
 * @param {(line: string) => void} [options.print] terminal printer for the URL block
 * @param {string} [options.assetsDir]
 * @param {Function} [options.fetch] bridge client self-check seam
 * @param {object} [options.sdk] preloaded SDK namespace (tests); res/load are then skipped
 * @param {Function} [options.importer] SDK import seam
 * @param {Function} [options.execFileSync] `npm root -g` seam for SDK discovery
 * @param {(path: string) => boolean} [options.exists]
 * @param {(path: string) => boolean} [options.isDirectory]
 * @param {Function} [options.createServer] bridge binding seam
 * @param {Function} [options.listen] bridge binding seam
 * @param {Function} [options.statusExecFile] `execFile` seam for the read-only Git query
 * @param {number} [options.subagentsTimeoutMs] read-only subagents RPC timeout (tests)
 * @param {number} [options.subagentsEventDebounceMs] subagents hint coalescing window (tests)
 * @param {number} [options.subagentsInspectTimeoutMs] structured inspection deadline (tests)
 * @returns {Promise<object>} the running host handle
 */
export async function startHost({
	cwd = process.cwd(),
	urlFile = DEFAULT_URL_FILE,
	env = process.env,
	logger = () => {},
	print = (line) => process.stdout.write(`${line}\n`),
	/** Called once the bridge listens (before extensions bind); useful for tests and launchers. */
	onReady = null,
	assetsDir = DEFAULT_ASSETS_DIR,
	fetch = globalThis.fetch,
	sdk = null,
	importer,
	execFileSync,
	exists,
	isDirectory,
	platform,
	homedir,
	createServer,
	listen,
	statusExecFile = undefined,
	subagentsTimeoutMs = undefined,
	subagentsEventDebounceMs = undefined,
	subagentsInspectTimeoutMs = undefined,
} = {}) {
	let store = null;
	let uiContext = null;
	let session = null;
	let chat = null;
	let model = null;
	let status = null;
	let subagents = null;
	let subagentsChannel = null;
	let bridge = null;
	let lifecycle = null;
	let sdkInfo = null;
	let urlFileWritten = false;
	let closed = false;

	function removeUrlFile() {
		if (!urlFile || !urlFileWritten) {
			return;
		}
		urlFileWritten = false;
		rmSync(urlFile, { force: true });
	}

	/** Release the read-only subagents adapter; the shared event bus stays usable until the session is gone. */
	function releaseSubagents(errorTarget = []) {
		try {
			lifecycle?.detachSubagents();
			subagents?.dispose?.();
		} catch (error) {
			errorTarget.push(`could not release the subagent adapter: ${errorMessage(error)}`);
		}
		subagents = null;
	}

	/** Drop every remaining extension event-bus subscription; shutdown only, after the session is gone. */
	function clearSubagentsBus(errorTarget = []) {
		try {
			subagentsChannel?.eventBus?.clear?.();
		} catch (error) {
			errorTarget.push(`could not clear the extension event bus: ${errorMessage(error)}`);
		}
	}

	async function cleanupFailedStart() {
		try {
			uiContext?.deactivate?.();
		} catch {
			// best effort only; the startup error is the signal that matters
		}
		try {
			store?.cancelAll("startup_failed");
		} catch {
			// best effort only
		}
		try {
			await bridge?.close();
		} catch (error) {
			logger(`could not close the bridge after a failed start: ${errorMessage(error)}`);
		}
		removeUrlFile();
		try {
			lifecycle?.detachChat();
			chat?.dispose?.();
		} catch (error) {
			logger(`could not release the chat adapter after a failed start: ${errorMessage(error)}`);
		}
		try {
			lifecycle?.detachModel();
			model?.dispose?.();
		} catch (error) {
			logger(`could not release the model adapter after a failed start: ${errorMessage(error)}`);
		}
		try {
			lifecycle?.detachStatus();
			status?.dispose?.();
		} catch (error) {
			logger(`could not release the status adapter after a failed start: ${errorMessage(error)}`);
		}
		try {
			releaseSubagents();
		} catch (error) {
			logger(`could not release the subagent adapter after a failed start: ${errorMessage(error)}`);
		}
		try {
			session?.dispose?.();
		} catch (error) {
			logger(`could not release the session after a failed start: ${errorMessage(error)}`);
		}
		try {
			clearSubagentsBus();
		} catch (error) {
			logger(`could not clear the extension event bus after a failed start: ${errorMessage(error)}`);
		}
	}

	/**
	 * Publish the URL as soon as the bridge listens, before extensions bind:
	 * `bindExtensions` awaits `session_start` handlers, and one of them may raise a dialog
	 * (project trust, login, any extension prompt) that can only be answered from the page.
	 */
	function publishReady() {
		if (urlFile) {
			try {
				mkdirSync(dirname(urlFile), { recursive: true });
				writeFileSync(urlFile, `${bridge.url}\n`, { encoding: "utf8", mode: 0o600 });
				urlFileWritten = true;
			} catch (error) {
				logger(`could not write the URL file at ${urlFile}: ${errorMessage(error)}`);
			}
		}
		print(`Pi GUI host listening: ${bridge.url}`);
		try {
			onReady?.({ url: bridge.url, port: bridge.port, origin: bridge.origin, urlFile });
		} catch (error) {
			logger(`the onReady hook threw after the bridge started: ${errorMessage(error)}`);
		}
	}

	try {
		if (sdk) {
			const missing = missingSdkExports(sdk);
			if (missing.length > 0) {
				throw new HostStartupError(
					`the injected SDK is missing ${missing.join(", ")}; the GUI host refuses to start with an unknown host shape`,
					{ stage: "sdk-shape" },
				);
			}
			sdkInfo = { source: "injected", entryPath: null, version: null };
		} else {
			const loaded = await loadHostSdk({
				env,
				...(importer ? { importer } : {}),
				...(execFileSync ? { execFileSync } : {}),
				...(exists ? { exists } : {}),
				...(isDirectory ? { isDirectory } : {}),
				...(platform ? { platform } : {}),
				...(homedir ? { homedir } : {}),
			});
			if (loaded.error) {
				throw new HostStartupError(loaded.error, { stage: "sdk-resolve", attempts: loaded.attempts });
			}
			sdk = loaded.sdk;
			sdkInfo = { source: loaded.source, entryPath: loaded.entryPath, version: loaded.version };
		}

		store = new RequestStore();
		// Keep the store's dialog generation aligned with the generation the bridge publishes.
		store.setGeneration(HOST_GENERATION);
		uiContext = createBrowserUIContext({ store, logger });
		lifecycle = createHostLifecycle();

		// The read-only pi-subagents panel needs the *shared extension event bus* that
		// `pi.events` exposes to every extension. The session has no public path to it, so the
		// host owns the bus (public `sdk.createEventBus()`) and hands it to Pi's own resource
		// loader, which keeps the default discovery (cwd, agent dir, settings manager) that
		// `createAgentSession()` would have used itself. See `src/host/subagents.js`.
		// Optional extra extensions for this GUI session (acceptance probes, user add-ons).
		// Never replaces Pi's default discovery: the loader appends these paths.
		const extraExtensionPaths = String(env[EXTRA_EXTENSIONS_ENV] ?? "")
			.split(/[;,]/)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		subagentsChannel = openSubagentsChannel({ sdk, cwd, logger, extraExtensionPaths });
		if (extraExtensionPaths.length > 0) {
			logger(`browser UI: extra extension paths: ${extraExtensionPaths.join(", ")}`);
		}

		// The bridge must serve before extensions bind: `bindExtensions` awaits every
		// `session_start` handler, and a handler that raises a dialog (project trust, login
		// or any extension prompt) would otherwise wait for an answer nobody can give yet.
		bridge = await startBridgeServer({
			store,
			assetsDir,
			control: lifecycle,
			logger,
			fetch,
			...(createServer ? { createServer } : {}),
			...(listen ? { listen } : {}),
		});
		publishReady();

		// A caller-provided resource loader must be reloaded by the caller (the SDK skips its
		// own reload for it). This is the same call the SDK would make for its default loader;
		// the bridge already serves, so a dialog raised while loading is answerable.
		if (subagentsChannel.resourceLoader) {
			try {
				await subagentsChannel.resourceLoader.reload();
			} catch (error) {
				throw new HostStartupError(
					`could not load the session resources (extensions, skills, prompts, themes): ${errorMessage(error)}`,
					{ stage: "resources", cause: error },
				);
			}
		}

		// A new session in Pi's normal session directory for this cwd, so `pi -c` can
		// continue it later. `persist` is left at its default on purpose.
		const sessionManager = sdk.SessionManager.create(cwd);
		const created = await sdk.createAgentSession({
			cwd,
			sessionManager,
			...(subagentsChannel.resourceLoader ? { resourceLoader: subagentsChannel.resourceLoader } : {}),
		});
		if (!created?.session || typeof created.session.bindExtensions !== "function") {
			throw new HostStartupError(
				"createAgentSession() did not return a session with bindExtensions(); the installed host shape is not supported",
				{ stage: "session" },
			);
		}
		session = created.session;
		const missingMembers = missingSessionMembers(session);
		if (missingMembers.length > 0) {
			throw new HostStartupError(
				`createAgentSession() returned a session without the public members the browser chat requires: ${missingMembers.join(", ")}; the installed host shape is not supported`,
				{ stage: "session" },
			);
		}
		const missingModel = missingModelMembers(session);
		if (missingModel.length > 0) {
			throw new HostStartupError(
				`createAgentSession() returned a session without the public actions the browser model controls require: ${missingModel.join(", ")}; the installed host shape is not supported`,
				{ stage: "session" },
			);
		}
		// Model/thinking and status only read the session, so they are attached before the
		// extensions bind: a page opened during a startup dialog already shows them. The
		// status adapter reads cwd/Git/usage and never sends anything to the session.
		model = lifecycle.attachModel(new HostModelBridge({ session, generation: HOST_GENERATION, logger }));
		status = lifecycle.attachStatus(new HostStatusBridge({
			session,
			generation: HOST_GENERATION,
			fallbackCwd: cwd,
			logger,
			...(typeof statusExecFile === "function" ? { execFile: statusExecFile } : {}),
		}));
		await session.bindExtensions({ uiContext, mode: HOST_UI_MODE });
		// Chat binds after extensions: the command catalog needs the bound extension runner,
		// and the bridge already serves startup dialogs during binding, so `/api/state`
		// simply carries no chat section until this point.
		chat = lifecycle.attachChat(new HostChatBridge({
			session,
			generation: HOST_GENERATION,
			logger,
			// A subagent tool result names the async run it launched. Forwarding those ids keeps
			// the structured view reachable from the chat row; the channel bounds and re-checks
			// them, and the subagents adapter may not exist yet at this point.
			onSubagentRunIds: (ids) => subagents?.retainReferencedAsyncIds(ids),
		}));
		// The read-only subagents adapter binds last: pi-subagents registers its RPC owner while
		// its extension factory is loaded and answers once `session_start` has run, so after
		// `bindExtensions` the first ping/status answers without waiting for a dialog. Its
		// initial bind is intentionally not awaited: a missing or slow RPC owner must never
		// delay startup, and `/api/state` reports the honest state while it is still loading.
		if (subagentsChannel.eventBus) {
			subagents = lifecycle.attachSubagents(new HostSubagentsBridge({
				eventBus: subagentsChannel.eventBus,
				generation: HOST_GENERATION,
				logger,
				// The structured inspect channel drives the pi-subagents command through this
				// session and captures its widget payload from our UI context; neither path
				// touches the chat bridge or the model.
				session,
				uiContext,
				// The child session reader derives its path from the parent session file, which
				// only exists once the session does — hence a getter instead of a value.
				getSessionFile: () => readSessionFile(session),
				...(Number.isFinite(subagentsTimeoutMs) && subagentsTimeoutMs > 0 ? { timeoutMs: subagentsTimeoutMs } : {}),
				...(Number.isFinite(subagentsEventDebounceMs) && subagentsEventDebounceMs >= 0 ? { eventDebounceMs: subagentsEventDebounceMs } : {}),
				...(Number.isFinite(subagentsInspectTimeoutMs) && subagentsInspectTimeoutMs > 0 ? { inspectTimeoutMs: subagentsInspectTimeoutMs } : {}),
			}));
		} else {
			logger(`browser subagents: the read-only pi-subagents panel stays unattached: ${subagentsChannel.reason}`);
		}
	} catch (error) {
		await cleanupFailedStart();
		if (error instanceof HostStartupError) {
			throw error;
		}
		const code = typeof error?.code === "string" && error.code.length > 0 ? ` [${error.code}]` : "";
		throw new HostStartupError(`${errorMessage(error)}${code}`, { stage: "startup", cause: error });
	}

	const sessionFile = readSessionFile(session);
	print("Pi GUI host ready");
	print(`  cwd: ${cwd}`);
	print(`  session: ${sessionFile ?? "new session in Pi's default session directory for this cwd"}`);
	print(`  SDK: ${sdkInfo.entryPath ?? "(injected)"}${sdkInfo.version ? ` (Pi ${sdkInfo.version})` : ""} via ${sdkInfo.source}`);
	print(`  URL file: ${urlFile ?? "(disabled)"}`);

	return {
		url: bridge.url,
		port: bridge.port,
		origin: bridge.origin,
		cwd,
		urlFile,
		sdk: sdkInfo,
		store,
		uiContext,
		session,
		chat,
		model,
		status,
		subagents,
		lifecycle,
		bridge,
		sessionFile,
		get pendingCount() {
			return store.pendingCount;
		},
		/** Keep the process alive on the listener while the host owns the session. */
		keepAlive: () => bridge.server?.ref?.(),
		/**
		 * Release every host resource: pending dialogs end with their non-approval result,
		 * the listener closes, the URL file is removed and the session handle is disposed.
		 * Idempotent; errors are reported instead of thrown so shutdown always completes.
		 */
		async close(reason = "shutdown") {
			if (closed) {
				return { cancelled: [], errors: [] };
			}
			closed = true;
			const errors = [];
			try {
				uiContext.deactivate();
			} catch (error) {
				errors.push(`could not deactivate the UI context: ${errorMessage(error)}`);
			}
			const cancelled = store.cancelAll(reason);
			try {
				await bridge.close();
			} catch (error) {
				errors.push(`could not close the bridge server: ${errorMessage(error)}`);
			}
			try {
				removeUrlFile();
			} catch (error) {
				errors.push(`could not remove the URL file: ${errorMessage(error)}`);
			}
			try {
				lifecycle.detachChat();
				chat?.dispose?.();
			} catch (error) {
				errors.push(`could not release the chat adapter: ${errorMessage(error)}`);
			}
			try {
				lifecycle.detachModel();
				model?.dispose?.();
			} catch (error) {
				errors.push(`could not release the model adapter: ${errorMessage(error)}`);
			}
			try {
				lifecycle.detachStatus();
				status?.dispose?.();
			} catch (error) {
				errors.push(`could not release the status adapter: ${errorMessage(error)}`);
			}
			releaseSubagents(errors);
			try {
				session.dispose?.();
			} catch (error) {
				errors.push(`could not dispose the session: ${errorMessage(error)}`);
			}
			clearSubagentsBus(errors);
			return { cancelled, errors };
		},
		/** Synchronous best effort for the `exit` event, where async cleanup is not possible. */
		exitCleanup() {
			try {
				uiContext.deactivate();
			} catch {
				// no further reporting is possible during `exit`
			}
			try {
				store.cancelAll("exit");
			} catch {
				// best effort only
			}
			try {
				lifecycle?.detachChat();
				chat?.dispose?.();
			} catch {
				// best effort only
			}
			try {
				lifecycle?.detachModel();
				model?.dispose?.();
			} catch {
				// best effort only
			}
			try {
				lifecycle?.detachStatus();
				status?.dispose?.();
			} catch {
				// best effort only
			}
			try {
				releaseSubagents();
			} catch {
				// best effort only
			}
			try {
				clearSubagentsBus();
			} catch {
				// best effort only
			}
			try {
				removeUrlFile();
			} catch {
				// best effort only
			}
		},
	};
}
