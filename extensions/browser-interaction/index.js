/**
 * Pi extension: local browser interaction bridge (version-limited, Pi 0.85.1).
 *
 * Load explicitly:
 *   pi -e ./extensions/browser-interaction/index.js
 *
 * The factory only registers handlers, a command and the runner-capture hook. The
 * loopback server and the UI binding start in `session_start` (or `/browser-ui start`)
 * and are released on real host quit, because extension factories may run in
 * invocations that never start a session.
 *
 * Reload continuity: the listening server, access token and request store are
 * process-owned (see src/core/bridge-registry.js), so a browser-initiated or terminal
 * reload keeps the same URL and token while the binding generation changes.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserBridge } from "../../src/adapter/browser-bridge.js";
import { SUPPORTED_HOST_VERSION } from "../../src/adapter/compat.js";
import { capturedRunner, captureInfo, installRunnerCapture, releaseCapturedRunner } from "../../src/adapter/runner-capture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const ASSETS_DIR = join(REPO_ROOT, "src", "browser");

/** Default location of the file holding the current browser URL (see README). */
export const DEFAULT_URL_FILE = join(REPO_ROOT, ".browser-ui", "url");

/** Set to "0" to require an explicit `/browser-ui start` in every session. */
export const AUTOSTART_ENV = "PI_BROWSER_UI_AUTOSTART";

/** Override the URL file location (used by tests and non-standard layouts). */
export const URL_FILE_ENV = "PI_BROWSER_UI_URL_FILE";

export const COMMAND_NAME = "browser-ui";

export default async function browserInteraction(pi) {
	// Capture the live ExtensionRunner through the approved version-limited UI binding
	// seam. Failure is not fatal here: the bridge refuses to attach later, with an
	// explicit error, instead of silently falling back to terminal prompts.
	const capture = await installRunnerCapture();
	const urlFile = process.env[URL_FILE_ENV]?.trim() || DEFAULT_URL_FILE;
	const bridge = new BrowserBridge({ assetsDir: ASSETS_DIR, urlFile });

	const report = (ctx, message, type = "info") => {
		try {
			ctx.ui.notify(message, type);
		} catch {
			// The UI may be unavailable while the host tears down; the shared log keeps the record.
		}
	};

	const attach = async (ctx, { announce }) => {
		try {
			const info = await bridge.attach({ runner: capturedRunner(), mode: ctx.mode, pi, ctx });
			if (announce) {
				report(
					ctx,
					`Browser UI ready: ${info.url}\n` +
						`(Pi ${info.hostVersion} · prompts are answered in the browser; the page can also reload this session.)`,
					"info",
				);
				ctx.ui.setStatus?.(COMMAND_NAME, `browser UI :${info.port}`);
			}
			return info;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			for (const detail of error?.errors ?? []) {
				report(ctx, `Browser UI detail: ${detail}`, "warning");
			}
			report(ctx, `Browser UI not started: ${reason}`, "error");
			// During a browser-requested reload the old binding is already gone, but
			// the shared server must stay alive long enough for requestReload() to
			// report the replacement attach failure to the browser. Initial attach
			// failures keep the existing release behaviour.
			const duringReload = bridge.registry.reloadInFlight;
			await bridge.detach("attach-failed", { release: !duringReload, awaitingReload: false });
			return null;
		}
	};

	for (const eventType of [
		"agent_start",
		"agent_end",
		"agent_settled",
		"message_start",
		"message_update",
		"message_end",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
		"model_select",
		"thinking_level_select",
		"session_compact",
		"session_tree",
	]) {
		pi.on(eventType, async (event, ctx) => {
			bridge.handleSessionEvent(event, ctx);
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		if (process.env[AUTOSTART_ENV] === "0") {
			return;
		}
		await attach(ctx, { announce: true });
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const reason = String(event.reason);
		const { released } = await bridge.detach(`session_shutdown:${reason}`);
		if (released) {
			releaseCapturedRunner();
		}
		try {
			ctx.ui.setStatus?.(COMMAND_NAME, undefined);
		} catch {
			// best effort; the host may already be tearing the UI down
		}
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Browser UI: start | reload | stop | url | status",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "status";
			switch (action) {
				case "start": {
					if (ctx.mode !== "tui") {
						report(ctx, `/${COMMAND_NAME} start requires interactive (tui) mode`, "warning");
						return;
					}
					const info = await attach(ctx, { announce: true });
					if (info) {
						report(ctx, `Browser UI running at ${info.url}`, "info");
					}
					return;
				}
				case "reload": {
					const result = await bridge.requestReload({ runner: capturedRunner() });
					if (!result.ok) {
						report(ctx, `Browser UI reload not performed: ${result.message ?? result.code}`, "warning");
						return;
					}
					// After a successful reload this instance is stale; keep the report minimal.
					report(ctx, `Browser UI: session reloaded, browser generation ${result.generation}.`, "info");
					return;
				}
				case "stop": {
					const { stopped, cancelled } = await bridge.stop("command");
					report(
						ctx,
						stopped
							? `Browser UI stopped; ${cancelled.length} pending prompt(s) ended without approval.`
							: "Browser UI was not running.",
						"info",
					);
					ctx.ui.setStatus?.(COMMAND_NAME, undefined);
					return;
				}
				case "url": {
					const url = bridge.url;
					if (!url) {
						report(ctx, "Browser UI is not running. Use /browser-ui start.", "warning");
						return;
					}
					report(ctx, `Browser UI URL: ${url}\nURL file: ${bridge.registry.urlFile}`, "info");
					return;
				}
				case "status": {
					const info = bridge.info({ uiContext: ctx.ui });
					const captureState = captureInfo();
					const captureSource = captureState.usedSource ?? "none";
					const attemptedSource = captureState.source ?? "none";
					const candidateUrl = captureState.candidateUrl ?? "(none)";
					const captureError = captureState.error ?? capture.error ?? "unknown capture failure";
					report(
						ctx,
						[
							`Browser UI: ${info.running ? "running" : "stopped"} · generation ${info.generation}${info.reloading ? " (reloading)" : ""}`,
							`URL: ${info.url ?? "(none)"}`,
							`Pi version: ${info.hostVersion ?? "(unknown)"} (supported: ${SUPPORTED_HOST_VERSION})`,
							`ctx.ui binding: ${
								info.binding.attached
									? info.binding.ok
										? "bound through the host prompt wrapper"
										: `not bound (${info.binding.reason})`
									: "not attached in this instance"
							}`,
							captureState.patchInstalled && captureState.captures > 0
								? `Runner capture: ${captureState.captures} bind(s) via ${captureSource}; candidate URL: ${candidateUrl}; attempts: ${captureState.attempts} candidate attempt(s)`
								: captureState.patchInstalled
									? `Runner capture: capture installed but has not bound to a live runner; GUI will refuse to enable; attempted source: ${attemptedSource}; patched source: ${captureSource}; candidate URL: ${candidateUrl}; attempts: ${captureState.attempts} candidate attempt(s)`
									: `Runner capture: failed: ${captureError}; attempted source: ${attemptedSource}; used source: none; candidate URL: ${candidateUrl}; attempts: ${captureState.attempts} candidate attempt(s)`,
							`${
								info.deliveryErrorVisibility
									? "Delivery failure visibility available through the host runner error stream"
									: "Delivery failure visibility unavailable: accepted message delivery failures may not be visible (host runner has no usable onError stream)"
							}`,
							`Pending prompts: ${info.pending}`,
							`URL file: ${info.urlFile ?? "(none)"}`,
							`Recent log:`,
							...bridge.logTail(5).map((line) => `  ${line}`),
						].join("\n"),
						"info",
					);
					return;
				}
				default: {
					report(
						ctx,
						[
							`/${COMMAND_NAME} <action>`,
							"  start   start the loopback bridge and bind browser prompt answering",
							"  reload  reload extensions from the terminal (the browser page can do this too)",
							"  stop    stop the bridge and end pending prompts without approval",
							"  url     print the current browser URL (contains the access token)",
							"  status  show bridge, compatibility and binding state",
						].join("\n"),
						"info",
					);
				}
			}
		},
	});
}
