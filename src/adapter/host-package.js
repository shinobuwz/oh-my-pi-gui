/**
 * Locate the Pi installation that is currently running.
 *
 * The prototype must not hardcode a personal installation path, so the package
 * root is derived from an explicit env override, from the running process
 * (`argv[1]` is the CLI entry that Pi was started with), or from a package lookup
 * anchored at that same entrypoint. Missing and Bun virtual entries are reported
 * explicitly instead of being treated as an on-disk installation.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PACKAGE_ROOT_ENV = "PI_BROWSER_UI_PACKAGE_ROOT";

function readManifest(packageRoot) {
	try {
		const manifestPath = join(packageRoot, "package.json");
		if (!existsSync(manifestPath)) {
			return null;
		}
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (manifest?.name !== HOST_PACKAGE_NAME || typeof manifest.version !== "string") {
			return null;
		}
		return { packageRoot, name: manifest.name, version: manifest.version };
	} catch {
		return null;
	}
}

function packageRootFromPath(startPath) {
	if (!startPath) {
		return null;
	}
	let current;
	try {
		current = startPath.startsWith("file:") ? fileURLToPath(startPath) : resolve(startPath);
	} catch {
		return null;
	}
	const { root } = parse(current);
	for (;;) {
		const found = readManifest(current);
		if (found) {
			return found;
		}
		if (current === root) {
			return null;
		}
		current = dirname(current);
	}
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

/**
 * Resolve a host package from a runtime entrypoint without consulting process-global
 * state. The realpath dependency is injectable so symlinked global-bin shapes can be
 * tested without requiring symlink creation privileges on the current platform.
 *
 * @param {string} runtimeEntry argv[1] entrypoint path or file URL
 * @param {{ realpath?: (path: string) => string }} [options]
 * @returns {{ packageRoot: string, name: string, version: string, source: string, entryPath: string, attempts: string[] } | { error: string, entryPath?: string, attempts: string[] }}
 */
export function resolveHostPackageFromEntry(runtimeEntry, { realpath = realpathSync } = {}) {
	const attempts = [];
	if (typeof runtimeEntry !== "string" || runtimeEntry.trim().length === 0) {
		attempts.push("process.argv[1] is missing; the running Pi package can not be identified");
		return { error: attempts[0], attempts };
	}
	if (isBunVirtualPath(runtimeEntry)) {
		const reason = `process.argv[1] uses Bun's virtual $bunfs path (${runtimeEntry}); the on-disk Pi package can not be identified from this entry`;
		attempts.push(reason);
		return { error: reason, attempts };
	}

	let entryPath;
	try {
		entryPath = runtimeEntry.startsWith("file:") ? fileURLToPath(runtimeEntry) : resolve(runtimeEntry);
	} catch (error) {
		const reason = `process.argv[1] could not be resolved: ${error instanceof Error ? error.message : String(error)}`;
		attempts.push(reason);
		return { error: reason, attempts };
	}

	// npm's POSIX global bin is normally a symlink. Use its target for both package
	// root traversal and the anchored require.resolve lookup, but retain argv[1] in
	// diagnostics and the returned source for compatibility with existing callers.
	let resolvedEntry = entryPath;
	try {
		const realpathEntry = realpath(entryPath);
		if (typeof realpathEntry === "string" && realpathEntry.length > 0) {
			resolvedEntry = realpathEntry;
		}
	} catch {
		// A missing or virtualized entry is still allowed to use the historical path;
		// the package lookup below reports the same failure/attempt details as before.
	}

	const found = packageRootFromPath(resolvedEntry);
	if (found) {
		return { ...found, source: `argv:${runtimeEntry}`, entryPath: resolvedEntry, attempts };
	}
	attempts.push(`process.argv[1]=${runtimeEntry} does not contain a ${HOST_PACKAGE_NAME} package root`);

	try {
		const require = createRequire(resolvedEntry);
		const manifestPath = require.resolve(`${HOST_PACKAGE_NAME}/package.json`);
		const resolved = readManifest(dirname(manifestPath));
		if (resolved) {
			return { ...resolved, source: `argv-resolve:${runtimeEntry}`, entryPath: resolvedEntry, attempts };
		}
		attempts.push(`argv[1] resolution found ${manifestPath} but it is not a ${HOST_PACKAGE_NAME} package root`);
	} catch (error) {
		attempts.push(`argv[1] package resolution failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		error: `process.argv[1]=${runtimeEntry} could not resolve a ${HOST_PACKAGE_NAME} package root`,
		entryPath: resolvedEntry,
		attempts,
	};
}

/**
 * Resolve the running Pi installation.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string[]} [options.argv]
 * @param {(path: string) => string} [options.realpath] injectable argv realpath function
 * @param {string} [options.baseUrl] retained for callers that pass the old option; argv[1] is the resolution anchor
 * @returns {{ packageRoot: string, version: string, source: string, entryPath?: string } | { error: string, attempts: string[] }}
 */
export function resolveHostPackage({ env = process.env, argv = process.argv, realpath = realpathSync, baseUrl: _baseUrl = import.meta.url } = {}) {
	const attempts = [];

	const override = env[PACKAGE_ROOT_ENV];
	if (override && override.trim().length > 0) {
		const found = readManifest(resolve(override.trim()));
		if (found) {
			return { ...found, source: `env:${PACKAGE_ROOT_ENV}` };
		}
		attempts.push(`${PACKAGE_ROOT_ENV}=${override} does not point at a ${HOST_PACKAGE_NAME} package root`);
	}

	const runtimeEntry = Array.isArray(argv) ? argv[1] : undefined;
	const fromEntry = resolveHostPackageFromEntry(runtimeEntry, { realpath });
	if (fromEntry.packageRoot) {
		return {
			packageRoot: fromEntry.packageRoot,
			name: fromEntry.name,
			version: fromEntry.version,
			source: fromEntry.source,
			entryPath: fromEntry.entryPath,
		};
	}
	attempts.push(...fromEntry.attempts);

	const entryReason =
		typeof runtimeEntry !== "string" || runtimeEntry.trim().length === 0
			? " process.argv[1] is missing, so no running Pi entry can be used."
			: isBunVirtualPath(runtimeEntry)
				? " process.argv[1] is a Bun $bunfs virtual entry and does not identify an on-disk Pi package."
			: "";
	return {
		error:
			`could not locate the running ${HOST_PACKAGE_NAME} installation.${entryReason} ` +
			`Set ${PACKAGE_ROOT_ENV} to the package root to allow the compatibility check.`,
		attempts,
	};
}

const NEWLINE = /\r?\n/;

/** Locate a globally installed Pi package root (used by tests and diagnostics). */
export function findGlobalHostPackage({ env = process.env, execFileSync } = {}) {
	const attempts = [];
	const override = env[PACKAGE_ROOT_ENV];
	if (override) {
		const found = readManifest(resolve(override));
		if (found) {
			return { ...found, source: `env:${PACKAGE_ROOT_ENV}` };
		}
		attempts.push(`${PACKAGE_ROOT_ENV} is not a ${HOST_PACKAGE_NAME} package root`);
	}
	if (!execFileSync) {
		return { error: "no global lookup function available", attempts };
	}
	try {
		// Windows: npm is a .cmd shim, which cannot be spawned directly without a shell.
		const [command, args] =
			process.platform === "win32"
				? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm root -g"]]
				: ["npm", ["root", "-g"]];
		const output = execFileSync(command, args, { encoding: "utf8" });
		const lines = output.split(NEWLINE).map((line) => line.trim()).filter((line) => line.length > 0);
		const globalRoot = lines.length > 0 ? lines[lines.length - 1] : "";
		if (globalRoot.length > 0) {
			const found = readManifest(join(globalRoot, ...HOST_PACKAGE_NAME.split("/")));
			if (found) {
				return { ...found, source: `global:${command}` };
			}
			attempts.push(`npm root -g returned ${globalRoot}, which has no ${HOST_PACKAGE_NAME}`);
		}
	} catch (error) {
		attempts.push(`global lookup failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { error: "global Pi installation not found", attempts };
}
