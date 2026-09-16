/**
 * Live `ExtensionRunner` capture for the private UI binding seam.
 *
 * `ExtensionRunner.setUIContext()` is the only seam that both receives the host's UI
 * context and applies Pi's own `withUIPrompt` lifecycle wrapper. To rebind it we need
 * the live runner instance, which is not exposed through `ExtensionAPI`.
 *
 * The default resolver selects the first existing entrypoint of the package that is
 * actually running (`dist/bundle/index.js` before `dist/index.js` for the bundled CLI,
 * otherwise the reverse order).
 * This absolute file-URL import is important: Node's native resolver cannot see a
 * globally installed package from a repository extension, even though the host loader
 * may provide the bare specifier through jiti virtual modules. The bare specifier is
 * retained as a final fallback for those loader contexts.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HOST_PACKAGE_NAME, resolveHostPackage } from "./host-package.js";
import { SUPPORTED_HOST_VERSION } from "./compat.js";

export const CAPTURE_MARKER = Symbol.for("oh-my-pi-gui.runner-capture.patched");
const STATE_MARKER = Symbol.for("oh-my-pi-gui.runner-capture.state");
const CAPTURE_KEY = Symbol.for("oh-my-pi-gui.runner-capture.v1");

function captureState() {
	if (!globalThis[CAPTURE_KEY]) {
		globalThis[CAPTURE_KEY] = {
			runner: null,
			captures: 0,
			capturedAt: 0,
			patchInstalled: false,
			source: null,
			usedSource: null,
			candidateUrl: null,
			attempts: 0,
			error: null,
		};
	}
	const state = globalThis[CAPTURE_KEY];
	// Keep state objects created by an older module evaluation usable after reload.
	if (!Object.prototype.hasOwnProperty.call(state, "source")) {
		state.source = null;
	}
	if (!Object.prototype.hasOwnProperty.call(state, "usedSource")) {
		state.usedSource = state.patchInstalled ? state.source : null;
	}
	if (!Object.prototype.hasOwnProperty.call(state, "candidateUrl")) {
		state.candidateUrl = null;
	}
	if (!Object.prototype.hasOwnProperty.call(state, "attempts")) {
		state.attempts = 0;
	}
	return state;
}

function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}

function isBunVirtualPath(candidate) {
	if (typeof candidate !== "string") {
		return false;
	}
	const normalized = candidate.replaceAll("\\", "/");
	return (
		normalized === "$bunfs" ||
		normalized.startsWith("$bunfs/") ||
		normalized.includes("/$bunfs/") ||
		normalized === "~BUN" ||
		normalized.startsWith("~BUN/") ||
		normalized.includes("/~BUN/")
	);
}

function runtimeEntryPath(candidate) {
	if (typeof candidate !== "string" || candidate.trim().length === 0) {
		return { error: "process.argv[1] is missing; the running Pi entrypoint can not be identified" };
	}
	if (isBunVirtualPath(candidate)) {
		return {
			error:
				`process.argv[1] uses Bun's virtual $bunfs path (${candidate}); it does not identify an on-disk Pi entrypoint`,
		};
	}
	try {
		const path = candidate.startsWith("file:") ? fileURLToPath(candidate) : candidate;
		return { path: resolve(path) };
	} catch (error) {
		return { error: `process.argv[1] could not be resolved: ${formatError(error)}` };
	}
}

function isWithin(entryPath, directory) {
	const child = relative(resolve(directory), resolve(entryPath));
	return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

function validRunner(module) {
	const Runner = module?.ExtensionRunner;
	return Runner && typeof Runner.prototype?.setUIContext === "function" ? Runner : null;
}

function failed(state, error) {
	state.patchInstalled = false;
	state.usedSource = null;
	state.error = error;
	return { ok: false, alreadyInstalled: false, error };
}

function installOnRunner(state, Runner, source, candidateUrl = null) {
	const current = Runner.prototype.setUIContext;
	if (current[CAPTURE_MARKER] === true && current[STATE_MARKER] === state) {
		state.patchInstalled = true;
		state.source = state.source ?? source;
		state.usedSource = state.usedSource ?? source;
		state.candidateUrl = candidateUrl;
		state.error = null;
		return { ok: true, alreadyInstalled: true, error: null };
	}
	const original = current;
	const patched = function setUIContext(...args) {
		state.runner = this;
		state.captures += 1;
		state.capturedAt = Date.now();
		return original.apply(this, args);
	};
	Object.defineProperty(patched, CAPTURE_MARKER, { value: true, enumerable: false });
	Object.defineProperty(patched, STATE_MARKER, { value: state, enumerable: false });
	Runner.prototype.setUIContext = patched;
	state.patchInstalled = true;
	state.source = source;
	state.usedSource = source;
	state.candidateUrl = candidateUrl;
	state.error = null;
	return { ok: true, alreadyInstalled: false, error: null };
}

/**
 * Install the prototype hook that records the live runner. Idempotent across
 * extension reloads because the bundled class object is stable within a process.
 *
 * @param {{ importer?: (specifier: string) => Promise<unknown>, env?: NodeJS.ProcessEnv, argv?: string[], realpath?: (path: string) => string }} [options]
 * @returns {Promise<{ ok: boolean, alreadyInstalled: boolean, error: string | null }>}
 */
export async function installRunnerCapture(options = {}) {
	const state = captureState();
	if (state.patchInstalled) {
		return { ok: true, alreadyInstalled: true, error: null };
	}
	// A retry starts a new diagnostic attempt while retaining the cumulative attempt
	// count. The source below always describes the last route tried, and usedSource is
	// set only after a runner shape has been successfully installed.
	state.source = null;
	state.usedSource = null;
	state.candidateUrl = null;
	state.error = null;

	const hostPackage = resolveHostPackage({
		env: options?.env ?? process.env,
		argv: options?.argv ?? process.argv,
		realpath: options?.realpath,
	});
	const packageResolutionFailure = hostPackage.error
		? `host package resolution failed for runner capture: ${hostPackage.error}` +
			(hostPackage.attempts?.length ? ` Attempts: ${hostPackage.attempts.join(" | ")}` : "")
		: null;

	// The importer hook is intentionally kept as a test seam. Supplying it preserves
	// the historical behaviour: only the bare specifier is passed to the hook. When
	// package-root discovery fails, it models the same virtual-specifier fallback and
	// keeps both failure causes in the diagnostic if the hook also fails.
	const hasInjectedImporter = options?.importer !== undefined;
	if (hasInjectedImporter) {
		state.attempts += 1;
		state.source = "injected";
		let module;
		try {
			module = await options.importer(HOST_PACKAGE_NAME);
		} catch (error) {
			const injectedFailure = `could not import ${HOST_PACKAGE_NAME} from inside the host process: ${formatError(error)}`;
			return failed(state, [packageResolutionFailure, injectedFailure].filter(Boolean).join("; "));
		}
		const Runner = validRunner(module);
		if (!Runner) {
			const injectedFailure =
				`the installed ${HOST_PACKAGE_NAME} (${SUPPORTED_HOST_VERSION}) does not expose ExtensionRunner.setUIContext`;
			return failed(state, [packageResolutionFailure, injectedFailure].filter(Boolean).join("; "));
		}
		return installOnRunner(state, Runner, "injected");
	}

	// There is no on-disk package root in Bun/SEA or a jiti virtual-module host. Do
	// not make that diagnosis terminal: the literal import below is the only path a
	// loader can intercept to provide the live class.
	if (hostPackage.error) {
		state.attempts += 1;
		state.source = "specifier";
		let specifierModule;
		try {
			// Keep this literal for loaders that virtualize the package specifier but
			// cannot intercept a computed dynamic import from a repository module.
			specifierModule = await import("@earendil-works/pi-coding-agent");
		} catch (error) {
			const specifierFailure = `bare specifier ${HOST_PACKAGE_NAME} import failed: ${formatError(error)}`;
			return failed(state, [packageResolutionFailure, specifierFailure].filter(Boolean).join("; "));
		}
		const Runner = validRunner(specifierModule);
		if (!Runner) {
			const specifierFailure =
				`bare specifier ${HOST_PACKAGE_NAME} loaded but does not expose ExtensionRunner.prototype.setUIContext`;
			return failed(state, [packageResolutionFailure, specifierFailure].filter(Boolean).join("; "));
		}
		return installOnRunner(state, Runner, "specifier", null);
	}

	const runtimeEntry = (options?.argv ?? process.argv)?.[1];
	const runtime = runtimeEntryPath(runtimeEntry);
	if (runtime.error) {
		state.source = null;
		return failed(state, `host runtime entry resolution failed for runner capture: ${runtime.error}`);
	}

	let hostEntryPath = hostPackage.entryPath ?? runtime.path;
	if (!hostPackage.entryPath) {
		try {
			const resolvedEntry = (options?.realpath ?? realpathSync)(runtime.path);
			if (typeof resolvedEntry === "string" && resolvedEntry.length > 0) {
				hostEntryPath = resolve(resolvedEntry);
			}
		} catch {
			// The already-normalized argv path remains the final fallback when the
			// runtime entry cannot be realpathed (for example, a virtual loader path).
		}
	}
	const fromBundle = isWithin(hostEntryPath, join(hostPackage.packageRoot, "dist", "bundle"));
	const candidates = fromBundle
		? [
				{ source: "bundle", path: join(hostPackage.packageRoot, "dist", "bundle", "index.js") },
				{ source: "dist", path: join(hostPackage.packageRoot, "dist", "index.js") },
		  ]
		: [
				{ source: "dist", path: join(hostPackage.packageRoot, "dist", "index.js") },
				{ source: "bundle", path: join(hostPackage.packageRoot, "dist", "bundle", "index.js") },
		  ];
	let candidate = null;
	const missingCandidates = [];
	for (const entry of candidates) {
		state.attempts += 1;
		if (existsSync(entry.path)) {
			candidate = entry;
			break;
		}
		missingCandidates.push(`${entry.source} candidate ${entry.path} does not exist`);
	}
	let candidateFailure = missingCandidates.join("; ") || null;
	let candidateModule;

	// Import only the first existing file candidate. Loading both dist graphs can
	// produce distinct ExtensionRunner classes, so a successful module with the wrong
	// shape is a hard failure rather than an invitation to patch another copy.
	if (candidate) {
		state.source = candidate.source;
		state.candidateUrl = pathToFileURL(candidate.path).href;
		try {
			candidateModule = await import(state.candidateUrl);
		} catch (error) {
			candidateFailure = `could not import ${candidate.source} candidate ${candidate.path}: ${formatError(error)}`;
		}
	}

	if (candidateModule) {
		const Runner = validRunner(candidateModule);
		if (!Runner) {
			return failed(
				state,
				`host runner candidate ${candidate.source} loaded from ${candidate.path} but does not expose ExtensionRunner.prototype.setUIContext`,
			);
		}
		return installOnRunner(state, Runner, candidate.source, state.candidateUrl);
	}

	// A missing/unloadable on-disk candidate may be running under jiti's virtual module
	// map, where the bare specifier is the only way to reach the live class.
	state.attempts += 1;
	state.source = "specifier";
	let specifierModule;
	try {
		// Keep this literal for loaders that can virtualize the package specifier but
		// cannot intercept a computed dynamic import from a repository module.
		specifierModule = await import("@earendil-works/pi-coding-agent");
	} catch (error) {
		const specifierFailure =
			`bare specifier ${HOST_PACKAGE_NAME} was unavailable after ${candidateFailure ?? "no on-disk host runner candidate was available"}: ${formatError(error)}`;
		return failed(state, specifierFailure);
	}
	const Runner = validRunner(specifierModule);
	if (!Runner) {
		const specifierFailure =
			`bare specifier ${HOST_PACKAGE_NAME} loaded after ${candidateFailure ?? "no on-disk host runner candidate was available"} but does not expose ExtensionRunner.prototype.setUIContext`;
		return failed(state, specifierFailure);
	}
	return installOnRunner(state, Runner, "specifier", null);
}

/** The most recently bound runner instance, or null. */
export function capturedRunner() {
	return captureState().runner;
}

export function captureInfo() {
	const state = captureState();
	return {
		captures: state.captures,
		capturedAt: state.capturedAt,
		patchInstalled: state.patchInstalled,
		source: state.source,
		usedSource: state.usedSource,
		candidateUrl: state.candidateUrl,
		attempts: state.attempts,
		error: state.error,
	};
}

/** Drop the reference to the current runner (used on host quit / explicit stop). */
export function releaseCapturedRunner() {
	const state = captureState();
	state.runner = null;
}

/** Discard all capture state (tests: process isolation between cases). */
export function resetRunnerCapture() {
	globalThis[CAPTURE_KEY] = undefined;
}
