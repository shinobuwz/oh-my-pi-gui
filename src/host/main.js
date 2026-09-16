/**
 * `pi-gui` SDK host launcher.
 *
 * One command starts a Pi agent session (public SDK), binds our browser-driven UI
 * context to it, serves the existing loopback page and publishes the URL:
 *
 *   npm start
 *   node src/host/main.js [--cwd <dir>] [--url-file <path>]
 *
 * It never modifies user settings or credentials and never falls back to terminal
 * interaction: any resolution, session or binding failure is printed and the process
 * exits non-zero without publishing a URL.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_URL_FILE, HostStartupError, startHost } from "./host.js";
import { HOST_PACKAGE_NAME, PACKAGE_ROOT_ENV, SDK_PATH_ENV } from "./sdk-loader.js";
import { UI_SUPPORT_SUMMARY } from "./ui-context.js";

export const USAGE = [
	"pi-gui: local browser GUI host for a Pi agent session (public SDK)",
	"",
	"Usage:",
	"  npm start [-- --cwd <dir>] [-- --url-file <path>]",
	"  node src/host/main.js [--cwd <dir>] [--url-file <path>]",
	"",
	"Options:",
	"  --cwd <dir>        session working directory (default: process.cwd())",
	"  --url-file <path>  where to write the browser URL (default: .browser-ui/url)",
	"  -h, --help         print this help and exit",
	"",
	"SDK resolution order (the first existing entry wins):",
	`  1. ${SDK_PATH_ENV}        explicit SDK module file or package root`,
	`  2. ${PACKAGE_ROOT_ENV}    explicit ${HOST_PACKAGE_NAME} package root`,
	"  3. common global npm roots: %APPDATA%/npm/node_modules (Windows),",
	"     /usr/local/lib/node_modules, /usr/lib/node_modules, ~/.npm-global/lib/node_modules",
	"  4. `npm root -g`",
	"An explicit environment override that does not contain the SDK is a startup error:",
	"the launcher fails closed instead of silently using another installation.",
	"",
	"Session: a new session is created in Pi's normal session directory for the cwd, so",
	"`pi -c` can continue it later. User settings, credentials and defaults are not modified.",
	"",
	"Browser UI support in this first version:",
	`  ${UI_SUPPORT_SUMMARY}`,
	"Nothing is silently ignored and no prompt goes to the terminal while the host runs.",
].join("\n");

/**
 * Parse the launcher arguments.
 *
 * @param {string[]} argv
 * @returns {{ help: true } | { cwd?: string, urlFile?: string } | { error: string }}
 */
export function parseArgs(argv = []) {
	const args = Array.isArray(argv) ? [...argv] : [];
	if (args.includes("--help") || args.includes("-h")) {
		return { help: true };
	}
	const parsed = {};
	while (args.length > 0) {
		const option = args.shift();
		if (option === "--cwd" || option === "--url-file") {
			const value = args.shift();
			if (value === undefined || value.startsWith("--")) {
				return { error: `${option} requires a value` };
			}
			if (option === "--cwd") {
				parsed.cwd = value;
			} else {
				parsed.urlFile = value;
			}
			continue;
		}
		if (option.startsWith("--")) {
			return { error: `unknown option: ${option}` };
		}
		return { error: `unexpected argument: ${option}` };
	}
	return parsed;
}

function formatStartupFailure(error) {
	const lines = [`the GUI host could not start: ${error?.message ?? String(error)}`];
	if (Array.isArray(error?.attempts) && error.attempts.length > 0) {
		lines.push("host SDK resolution attempts:");
		for (const attempt of error.attempts) {
			lines.push(`  - ${attempt}`);
		}
	}
	if (error instanceof HostStartupError && String(error.stage ?? "").startsWith("sdk")) {
		lines.push(`set ${SDK_PATH_ENV} to the SDK module (or its package root) or ${PACKAGE_ROOT_ENV} to the ${HOST_PACKAGE_NAME} package root.`);
	}
	return lines.join("\n");
}

/**
 * Parse arguments, start the host and report success/failure. Never installs signal
 * handlers and never calls `process.exit`, so tests can drive it directly.
 *
 * @returns {Promise<{ code: number, host?: object, url?: string, error?: Error }>}
 */
export async function runCli({
	argv = process.argv.slice(2),
	env = process.env,
	stdout = process.stdout,
	stderr = process.stderr,
	start = startHost,
	cwdBase = process.cwd(),
} = {}) {
	const args = parseArgs(argv);
	if (args.help) {
		stdout.write(`${USAGE}\n`);
		return { code: 0, help: true };
	}
	if (args.error) {
		stderr.write(`pi-gui: ${args.error}\n`);
		stderr.write('Run "node src/host/main.js --help" for usage.\n');
		return { code: 2, error: new Error(args.error) };
	}
	const cwd = args.cwd ? resolve(cwdBase, args.cwd) : cwdBase;
	const urlFile = args.urlFile ? resolve(cwdBase, args.urlFile) : resolve(cwdBase, DEFAULT_URL_FILE);
	const logger = (message) => stderr.write(`[pi-gui] ${message}\n`);
	try {
		const host = await start({ cwd, urlFile, env, logger, print: (line) => stdout.write(`${line}\n`) });
		return { code: 0, host, url: host.url, cwd, urlFile };
	} catch (error) {
		stderr.write(`pi-gui: ${formatStartupFailure(error)}\n`);
		return { code: 1, error };
	}
}

/**
 * Full launcher: run, keep the process alive on the listener, and release every
 * resource on SIGINT/SIGTERM or an unexpected failure.
 *
 * @returns {Promise<{ code: number, shutdownReason?: string, host?: object }>}
 */
export async function cli({
	argv = process.argv.slice(2),
	env = process.env,
	stdout = process.stdout,
	stderr = process.stderr,
	signals = process,
	start = startHost,
	cwdBase = process.cwd(),
} = {}) {
	const result = await runCli({ argv, env, stdout, stderr, start, cwdBase });
	if (!result.host) {
		return { code: result.code, error: result.error };
	}
	const host = result.host;
	host.keepAlive?.();

	let settle;
	const finished = new Promise((resolvePromise) => {
		settle = resolvePromise;
	});
	let closing = false;
	const handlers = [];
	const register = (event, handler) => {
		signals.once(event, handler);
		handlers.push([event, handler]);
	};
	const cleanupHandlers = () => {
		for (const [event, handler] of handlers) {
			signals.removeListener?.(event, handler);
		}
		handlers.length = 0;
	};
	const shutdown = async (reason, code) => {
		if (closing) {
			return;
		}
		closing = true;
		cleanupHandlers();
		const outcome = (await host.close(reason)) ?? {};
		for (const error of outcome.errors ?? []) {
			stderr.write(`[pi-gui] cleanup: ${error}\n`);
		}
		settle({ code, reason });
	};
	register("SIGINT", () => void shutdown("SIGINT", 130));
	register("SIGTERM", () => void shutdown("SIGTERM", 143));
	register("uncaughtException", (error) => {
		stderr.write(`pi-gui: uncaught exception: ${error?.stack ?? String(error)}\n`);
		void shutdown("uncaughtException", 1);
	});
	register("unhandledRejection", (reason) => {
		stderr.write(`pi-gui: unhandled rejection: ${reason?.stack ?? String(reason)}\n`);
		void shutdown("unhandledRejection", 1);
	});
	signals.once?.("exit", () => {
		try {
			host.exitCleanup?.();
		} catch {
			// nothing can be reported reliably during `exit`
		}
	});

	const outcome = await finished;
	return { ...result, code: outcome.code, shutdownReason: outcome.reason };
}

const invokedDirectly = (() => {
	const entry = process.argv[1];
	if (typeof entry !== "string" || entry.length === 0) {
		return false;
	}
	try {
		return import.meta.url === pathToFileURL(resolve(entry)).href;
	} catch {
		return false;
	}
})();

if (invokedDirectly) {
	const outcome = await cli();
	process.exitCode = outcome.code;
}
