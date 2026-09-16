/**
 * Locate and import the public Pi SDK for the GUI host process.
 *
 * The repository is an ESM package without a dependency on the Pi host package, so a
 * bare specifier such as `import("@earendil-works/pi-coding-agent")` fails here (see the
 * knowledge-base pitfall). The SDK is therefore always imported through the absolute
 * path of an existing `dist/index.js`.
 *
 * Resolution order (first existing entry wins):
 *   1. `PI_GUI_SDK_PATH` — explicit SDK module file, or a package root containing it
 *   2. `PI_GUI_PACKAGE_ROOT` — explicit `@earendil-works/pi-coding-agent` package root
 *   3. common global npm roots (`%APPDATA%/npm/node_modules` on Windows, then
 *      `/usr/local/lib/node_modules`, `/usr/lib/node_modules`,
 *      `~/.npm-global/lib/node_modules`)
 *   4. the output of `npm root -g`
 *
 * An explicit `PI_GUI_SDK_PATH` / `PI_GUI_PACKAGE_ROOT` that does not contain the SDK is a
 * hard error: the launcher fails closed instead of silently starting a different
 * installation. Every failure is reported with the attempted locations and the exports
 * that were missing; importing never falls back to a bare specifier or to terminal mode.
 */

import { execFileSync as nodeExecFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Installed Pi coding agent package the GUI host binds to. */
export const HOST_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
/** Explicit SDK module (or package root); takes precedence over every discovery step. */
export const SDK_PATH_ENV = "PI_GUI_SDK_PATH";
/** Explicit host package root; used when `PI_GUI_SDK_PATH` is not set. */
export const PACKAGE_ROOT_ENV = "PI_GUI_PACKAGE_ROOT";
/** SDK entry relative to the package root. */
export const SDK_ENTRY_SEGMENTS = Object.freeze(["dist", "index.js"]);
/** Upper bound for the last-resort `npm root -g` lookup. */
export const NPM_ROOT_TIMEOUT_MS = 15000;

const PACKAGE_SEGMENTS = Object.freeze(HOST_PACKAGE_NAME.split("/"));

function clean(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function readPackageVersion(packageRoot) {
	try {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		return manifest?.name === HOST_PACKAGE_NAME && typeof manifest.version === "string" ? manifest.version : null;
	} catch {
		return null;
	}
}

/**
 * Common global npm package roots for the current platform/user, in resolution order.
 * Paths are returned even when they do not exist; the caller records them as attempts.
 */
export function globalPackageRoots({ env = process.env, platform = process.platform, homedir = osHomedir() } = {}) {
	const roots = [];
	const appData = platform === "win32" ? clean(env.APPDATA) : "";
	if (appData) {
		roots.push(join(appData, "npm", "node_modules"));
	}
	if (clean(homedir)) {
		roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules", join(homedir, ".npm-global", "lib", "node_modules"));
	}
	return roots;
}

/** Run `npm root -g` through the platform-appropriate command shape. */
function runNpmRootGlobal({ env = process.env, platform = process.platform, execFileSync = nodeExecFileSync } = {}) {
	const [command, args] =
		platform === "win32"
			? [clean(env.ComSpec) || "cmd.exe", ["/d", "/s", "/c", "npm root -g"]]
			: ["npm", ["root", "-g"]];
	return execFileSync(command, args, { encoding: "utf8", timeout: NPM_ROOT_TIMEOUT_MS });
}

/**
 * Resolve the absolute SDK entry to import.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(path: string) => boolean} [options.exists] injectable existence check
 * @param {(path: string) => boolean} [options.isDirectory] injectable directory check
 * @param {Function | null} [options.execFileSync] injectable `npm root -g` runner; `null` disables it
 * @param {string} [options.platform]
 * @param {string} [options.homedir]
 * @returns {{ entryPath: string, source: string, packageRoot: string | null, attempts: string[] } | { error: string, attempts: string[] }}
 */
export function resolveSdkEntry({
	env = process.env,
	exists = existsSync,
	isDirectory = (path) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
	execFileSync = nodeExecFileSync,
	platform = process.platform,
	homedir = osHomedir(),
} = {}) {
	const attempts = [];
	const packageEntry = (root) => join(root, ...PACKAGE_SEGMENTS, ...SDK_ENTRY_SEGMENTS);
	const asModuleOrRoot = (candidate) => {
		const asFile = resolve(candidate);
		if (!isDirectory(asFile) && exists(asFile)) {
			return { entryPath: asFile, packageRoot: null };
		}
		const asRoot = join(asFile, ...SDK_ENTRY_SEGMENTS);
		return exists(asRoot) ? { entryPath: asRoot, packageRoot: asFile } : null;
	};

	const explicitModule = clean(env[SDK_PATH_ENV]);
	if (explicitModule) {
		const found = asModuleOrRoot(explicitModule);
		if (found) {
			return { ...found, source: `env:${SDK_PATH_ENV}`, attempts };
		}
		attempts.push(`${SDK_PATH_ENV}=${explicitModule} is neither an existing module file nor a package root containing ${SDK_ENTRY_SEGMENTS.join("/")}`);
		return {
			error: `${SDK_PATH_ENV}=${explicitModule} does not point at the ${HOST_PACKAGE_NAME} SDK; refusing to fall back to another installation`,
			attempts,
		};
	}

	const explicitRoot = clean(env[PACKAGE_ROOT_ENV]);
	if (explicitRoot) {
		const root = resolve(explicitRoot);
		const candidate = join(root, ...SDK_ENTRY_SEGMENTS);
		if (exists(candidate)) {
			return { entryPath: candidate, source: `env:${PACKAGE_ROOT_ENV}`, packageRoot: root, attempts };
		}
		attempts.push(`${PACKAGE_ROOT_ENV}=${explicitRoot} does not contain ${SDK_ENTRY_SEGMENTS.join("/")}`);
		return {
			error: `${PACKAGE_ROOT_ENV}=${explicitRoot} does not contain the ${HOST_PACKAGE_NAME} SDK entry; refusing to fall back to another installation`,
			attempts,
		};
	}

	for (const root of globalPackageRoots({ env, platform, homedir })) {
		const candidate = packageEntry(root);
		if (exists(candidate)) {
			return { entryPath: candidate, source: `global:${root}`, packageRoot: join(root, ...PACKAGE_SEGMENTS), attempts };
		}
		attempts.push(`global npm root ${root} does not contain ${PACKAGE_SEGMENTS.join("/")}/${SDK_ENTRY_SEGMENTS.join("/")}`);
	}

	if (typeof execFileSync !== "function") {
		attempts.push("`npm root -g` lookup is disabled in this process");
	} else {
		let output = null;
		try {
			output = String(runNpmRootGlobal({ env, platform, execFileSync }) ?? "");
		} catch (error) {
			attempts.push(`\`npm root -g\` failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (output !== null) {
			const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
			const globalRoot = lines.at(-1) ?? "";
			if (globalRoot) {
				const candidate = packageEntry(globalRoot);
				if (exists(candidate)) {
					return { entryPath: candidate, source: `npm-root-g:${globalRoot}`, packageRoot: join(globalRoot, ...PACKAGE_SEGMENTS), attempts };
				}
				attempts.push(`\`npm root -g\` returned ${globalRoot}, which does not contain ${PACKAGE_SEGMENTS.join("/")}/${SDK_ENTRY_SEGMENTS.join("/")}`);
			} else {
				attempts.push("`npm root -g` returned no path");
			}
		}
	}

	return {
		error:
			`could not locate the ${HOST_PACKAGE_NAME} SDK. Set ${SDK_PATH_ENV} to the SDK module ` +
			`(or its package root) or ${PACKAGE_ROOT_ENV} to the package root.`,
		attempts,
	};
}

/** Report the exports the host needs from the SDK namespace, so a shape change fails closed. */
export function missingSdkExports(sdk) {
	const missing = [];
	if (typeof sdk?.createAgentSession !== "function") {
		missing.push("createAgentSession");
	}
	if (typeof sdk?.SessionManager?.create !== "function") {
		missing.push("SessionManager.create");
	}
	return missing;
}

/**
 * Resolve, import and shape-check the SDK namespace.
 *
 * @returns {Promise<{ sdk: object, entryPath: string, source: string, version: string | null, attempts: string[] } | { error: string, attempts: string[], entryPath?: string, missing?: string[] }>}
 */
export async function loadHostSdk({
	env = process.env,
	exists = existsSync,
	isDirectory,
	execFileSync = nodeExecFileSync,
	importer = (url) => import(url),
	platform = process.platform,
	homedir = osHomedir(),
} = {}) {
	const resolved = resolveSdkEntry({ env, exists, ...(isDirectory ? { isDirectory } : {}), execFileSync, platform, homedir });
	if (resolved.error) {
		return resolved;
	}
	const url = pathToFileURL(resolved.entryPath).href;
	let sdk;
	try {
		sdk = await importer(url);
	} catch (error) {
		return {
			error: `failed to import the ${HOST_PACKAGE_NAME} SDK from ${resolved.entryPath}: ${error instanceof Error ? error.message : String(error)}`,
			attempts: resolved.attempts,
			entryPath: resolved.entryPath,
		};
	}
	const missing = missingSdkExports(sdk);
	if (missing.length > 0) {
		return {
			error:
				`the module at ${resolved.entryPath} is not a usable ${HOST_PACKAGE_NAME} SDK: ` +
				`it is missing ${missing.join(", ")}. The GUI host refuses to start with an unknown host shape.`,
			attempts: resolved.attempts,
			entryPath: resolved.entryPath,
			missing,
		};
	}
	// The package root is known for discovery routes; a direct module path may live anywhere.
	const packageRoot = resolved.packageRoot ?? resolve(resolved.entryPath, "..", "..");
	return {
		sdk,
		entryPath: resolved.entryPath,
		source: resolved.source,
		packageRoot,
		version: readPackageVersion(packageRoot),
		attempts: resolved.attempts,
	};
}
