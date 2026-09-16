/**
 * Host test harness.
 *
 * Loads the real Pi extension runner/loader modules from the installed Pi package
 * (never `dist/bundle/cli.js`, which would boot user extensions) so tests exercise
 * the real shared-UI-context binding instead of a stubbed helper.
 *
 * The terminal UI implementation cannot run headless, so tests bind a "poisoned"
 * UI context whose blocking dialog methods throw. If the browser adapter ever failed
 * to intercept a dialog, the test would fail instead of silently using the terminal.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findGlobalHostPackage, PACKAGE_ROOT_ENV, resolveHostPackage, HOST_PACKAGE_NAME } from "../../src/adapter/host-package.js";
import { installRunnerCapture, resetRunnerCapture } from "../../src/adapter/runner-capture.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ADAPTER_ENTRY = join(REPO_ROOT, "extensions", "browser-interaction", "index.js");
export const CONSUMER_FIXTURE = join(REPO_ROOT, "test", "fixtures", "consumer-extension.js");
export const OBSERVER_FIXTURE = join(REPO_ROOT, "test", "fixtures", "observer-extension.js");
export const URL_FILE = join(REPO_ROOT, ".browser-ui", "url");
export const URL_FILE_ENV = "PI_BROWSER_UI_URL_FILE";

let cachedHost = null;
let cachedHostKey = null;

/** Preserve nested fetch diagnostics (notably Node's `cause: bad port`) in wait errors. */
export function formatErrorWithCause(error) {
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
	return parts.reduce((text, part, index) => index === 0 ? part : `${text}; cause: ${part}`, "");
}

/** Bad-port fetch failures cannot recover by polling the same URL. */
export function isNonRetryablePortError(error) {
	const seen = new Set();
	let current = error;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		const code = current?.code;
		const message = formatErrorWithCause(current);
		if (code === "ERR_UNSAFE_PORT" || /(?:bad|unsafe)[ _-]?port/i.test(message)) {
			return true;
		}
		current = current?.cause;
	}
	return false;
}

/** Locate the installed Pi package, or explain why the host tests cannot run. */
export function locateHostPackage() {
	const key = process.env[PACKAGE_ROOT_ENV] ?? "";
	if (cachedHost && cachedHostKey === key) {
		return cachedHost;
	}
	const fromProcess = resolveHostPackage({ env: process.env, argv: process.argv });
	if (!fromProcess.error) {
		cachedHost = fromProcess;
		cachedHostKey = key;
		return cachedHost;
	}
	const global = findGlobalHostPackage({ execFileSync });
	if (!global.error) {
		cachedHost = global;
		cachedHostKey = key;
		return cachedHost;
	}
	throw new Error(
		`could not locate the ${HOST_PACKAGE_NAME} installation for host binding tests. ` +
			`Set ${PACKAGE_ROOT_ENV} to the package root. Attempts: ${[...fromProcess.attempts, ...(global.attempts ?? [])].join(" | ")}`,
	);
}

export async function loadHostModules(packageRoot) {
	const distDir = join(packageRoot, "dist");
	// Production capture resolves the class from the package entry that is actually
	// running. Use the bundled package entry here too; taking ExtensionRunner from the
	// unbundled dist/index.js would exercise a different class than the real CLI.
	const hostNamespace = await import(pathToFileURL(join(distDir, "bundle", "index.js")).href);
	const extensionsIndex = await import(pathToFileURL(join(distDir, "core", "extensions", "index.js")).href);
	const runnerModule = await import(pathToFileURL(join(distDir, "core", "extensions", "runner.js")).href);
	return {
		hostNamespace,
		ExtensionRunner: hostNamespace.ExtensionRunner,
		loadExtensions: extensionsIndex.loadExtensions,
		createExtensionRuntime: extensionsIndex.createExtensionRuntime,
		wrapRegisteredTool: extensionsIndex.wrapRegisteredTool,
		emitSessionShutdownEvent: runnerModule.emitSessionShutdownEvent,
	};
}

/** A UI context that fails loudly if any blocking dialog reaches the terminal path. */
export function createPoisonedUiContext() {
	const dialogCalls = [];
	const notifications = [];
	const statuses = [];
	const makeDialog = (kind) => (...args) => {
		dialogCalls.push({ kind, args });
		throw new Error(`terminal ${kind} dialog must not be reached while the browser adapter is active`);
	};
	const uiContext = {
		select: makeDialog("select"),
		confirm: makeDialog("confirm"),
		input: makeDialog("input"),
		editor: makeDialog("editor"),
		custom: makeDialog("custom"),
		notify: (message, type) => {
			notifications.push({ message, type });
		},
		setStatus: (key, text) => {
			statuses.push({ key, text });
		},
		onTerminalInput: () => () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	Object.defineProperty(uiContext, "theme", { get: () => ({ fg: (_c, text) => text }), enumerable: true });
	return { uiContext, dialogCalls, notifications, statuses };
}

/** Load the adapter extension plus the consumer and observer fixtures through the real Pi loader. */
export async function loadExtensionsForTest({ packageRoot, extraExtensions = [], installCapture = true }) {
	const modules = await loadHostModules(packageRoot);
	// The shipped CLI and this harness both use the bundled ExtensionRunner class. The
	// importer hook remains explicit here so the unit-test loader can reuse that exact
	// namespace without relying on Node resolving a globally installed bare specifier
	// from the repository path.
	if (installCapture) {
		await installRunnerCapture({ importer: async () => modules.hostNamespace });
	}
	const loaded = await modules.loadExtensions(
		[ADAPTER_ENTRY, CONSUMER_FIXTURE, OBSERVER_FIXTURE, ...extraExtensions],
		REPO_ROOT,
		undefined,
		modules.createExtensionRuntime(),
	);
	if (loaded.errors.length > 0) {
		throw new Error(`extension load errors: ${loaded.errors.map((error) => `${error.path}: ${error.error}`).join(" | ")}`);
	}
	return { ...modules, loaded };
}

function bindHarnessCore(runner, { onReload = async () => {}, waitForIdle = async () => {} } = {}) {
	// Mirror the host: core actions first, then the command context (Pi's order in
	// AgentSession._bindExtensionCore / bindCommandContext / _applyExtensionBindings).
	runner.bindCore(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setSessionName: () => {},
			getSessionName: () => null,
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
			refreshTools: () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => "off",
			setThinkingLevel: () => {},
		},
		{
			getModel: () => undefined,
			getScopedModels: () => [],
			isIdle: () => true,
			isProjectTrusted: () => true,
			getSignal: () => undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
			getSystemPromptOptions: () => ({ cwd: REPO_ROOT }),
		},
	);
	runner.bindCommandContext({
		waitForIdle,
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: onReload,
	});
}

/**
 * A host stand-in that owns the extension lifecycle the way Pi does: it can boot a
 * generation (load extensions, bind core/command context/UI context, emit
 * session_start) and reload (session_shutdown -> invalidate -> reload resources ->
 * new runner -> session_start reason "reload"), matching AgentSession.reload().
 */
export async function createHostHarness({
	packageRoot,
	extraExtensions = [],
	appUiContextFactory = createPoisonedUiContext,
	waitForIdle = async () => {},
	installCapture = true,
	configureRunner = async () => {},
} = {}) {
	const hostModules = await loadHostModules(packageRoot);
	let generation = 0;
	let current = null;
	const generations = [];

	const boot = async ({ reason = "startup", previousSessionFile = undefined } = {}) => {
		const generationModules = await loadExtensionsForTest({ packageRoot, extraExtensions, installCapture });
		const poisoned = appUiContextFactory();
		const runner = new generationModules.ExtensionRunner(
			generationModules.loaded.extensions,
			generationModules.loaded.runtime,
			REPO_ROOT,
			{ getSessionFile: () => null },
			{ registerProvider: () => {}, registerNativeProvider: () => {}, unregisterProvider: () => {} },
		);
		bindHarnessCore(runner, { onReload: async () => { await host.reload(); }, waitForIdle });
		runner.setUIContext(poisoned.uiContext, "tui");
		generation += 1;
		const record = { generation, runner, poisoned, modules: generationModules };
		generations.push(record);
		current = record;
		await configureRunner(record);
		await runner.emit({ type: "session_start", reason, ...(previousSessionFile ? { previousSessionFile } : {}) });
		return record;
	};

	const host = {
		modules: hostModules,
		get current() {
			return current;
		},
		get generations() {
			return generations;
		},
		boot,
		/** The reload sequence AgentSession.reload() performs for a bound session. */
		async reload() {
			const old = current;
			await hostModules.emitSessionShutdownEvent(old.runner, { type: "session_shutdown", reason: "reload" });
			old.runner.invalidate();
			return boot({ reason: "reload" });
		},
		async shutdown(reason = "quit") {
			await hostModules.emitSessionShutdownEvent(current.runner, { type: "session_shutdown", reason });
			current.runner.invalidate();
		},
	};
	return host;
}

export async function createHarness({
	packageRoot,
	extraExtensions = [],
	poisoned = createPoisonedUiContext(),
	onReload = async () => {},
	waitForIdle = async () => {},
	installCapture = true,
} = {}) {
	const modules = await loadExtensionsForTest({ packageRoot, extraExtensions, installCapture });
	const runner = new modules.ExtensionRunner(
		modules.loaded.extensions,
		modules.loaded.runtime,
		REPO_ROOT,
		{ getSessionFile: () => null },
		{ registerProvider: () => {}, registerNativeProvider: () => {}, unregisterProvider: () => {} },
	);
	bindHarnessCore(runner, { onReload, waitForIdle });
	runner.setUIContext(poisoned.uiContext, "tui");
	return { modules, runner, poisoned, ...poisoned };
}

/**
 * The bridge registry is intentionally process-global (it must outlive a reload), so
 * tests reset it explicitly between cases to stay independent.
 */
export async function resetBridgeProcessState(urlFile = process.env[URL_FILE_ENV]?.trim() || URL_FILE) {
	const key = Symbol.for("oh-my-pi-gui.bridge-registry.v1");
	const registry = globalThis[key];
	if (registry?.server) {
		try {
			await registry.server.close();
		} catch {
			// the server may already be closed
		}
	}
	globalThis[key] = undefined;
	resetRunnerCapture();
	rmSync(urlFile, { force: true });
}

export function readBridgeUrl(urlFile = process.env[URL_FILE_ENV]?.trim() || URL_FILE) {
	if (!existsSync(urlFile)) {
		return null;
	}
	return readFileSync(urlFile, "utf8").trim();
}

export function splitUrl(url) {
	const parsed = new URL(url);
	const token = /(?:^|[#&])t=([A-Za-z0-9._-]+)/.exec(parsed.hash)?.[1] ?? null;
	return { origin: parsed.origin, port: Number(parsed.port), token };
}

/** Minimal authenticated HTTP client standing in for the browser's fetch calls. */
export function bridgeClient({ origin, token }) {
	const auth = { Authorization: `Bearer ${token}` };
	const json = (body, extraHeaders = {}) => ({
		"Content-Type": "application/json",
		...auth,
		...extraHeaders,
	});
	return {
		origin,
		token,
		async state() {
			const response = await fetch(`${origin}/api/state`, { headers: auth });
			if (!response.ok) {
				throw new Error(`state request failed: HTTP ${response.status}`);
			}
			return response.json();
		},
		async reload(body = {}) {
			const response = await fetch(`${origin}/api/reload`, {
				method: "POST",
				headers: json(undefined, { Origin: origin }),
				body: JSON.stringify(body),
			});
			const payload = await response.json().catch(() => ({}));
			return { status: response.status, payload };
		},
		async answer(id, value, action = "answer") {
			const response = await fetch(`${origin}/api/answer`, {
				method: "POST",
				headers: json(undefined, { Origin: origin }),
				body: JSON.stringify({ id, action, value }),
			});
			const payload = await response.json().catch(() => ({}));
			return { status: response.status, payload };
		},
		async waitForPending(kind, { timeoutMs = 15000 } = {}) {
			const snapshot = await this.waitForSnapshot(1, { kind, timeoutMs });
			return snapshot.pending.find((request) => request.kind === kind && !request.unsupported);
		},
		async waitForSnapshot(count, { kind = null, timeoutMs = 15000 } = {}) {
			const deadline = Date.now() + timeoutMs;
			let lastError = null;
			for (;;) {
				try {
					const snapshot = await this.state();
					const matching = snapshot.pending.filter((request) => !request.unsupported && (kind === null || request.kind === kind));
					if (matching.length >= count) {
						return { ...snapshot, pending: matching };
					}
				} catch (error) {
					lastError = error;
					if (isNonRetryablePortError(error)) {
						throw new Error(
							`non-retryable bridge error while waiting for ${count} pending ${kind ?? "prompt"} request(s): ${formatErrorWithCause(error)}`,
							{ cause: error },
						);
					}
				}
				if (Date.now() > deadline) {
					const detail = lastError ? `: ${formatErrorWithCause(lastError)}` : "";
					throw new Error(`expected ${count} pending ${kind ?? "prompt"} request(s) within ${timeoutMs}ms${detail}`, {
						cause: lastError ?? undefined,
					});
				}
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
			}
		},
	};
}

/** Temporary fake Pi installation used by the compatibility tests. */
export function createFakeHostPackage({ version = "0.0.0", name = HOST_PACKAGE_NAME } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }, null, 2));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Find a registered extension tool by name and wrap it with the host's own
 * wrapRegisteredTool, so execution receives the runner context exactly like the
 * real host tool registry does.
 */
export function toolDefinition(modules, runner, name) {
	const registered = runner.getAllRegisteredTools().find((tool) => tool.definition.name === name);
	if (!registered) {
		throw new Error(`tool ${name} is not registered`);
	}
	return modules.wrapRegisteredTool(registered, runner);
}

export function parseToolResult(result) {
	const text = result?.content?.[0]?.text ?? "";
	return JSON.parse(text);
}
