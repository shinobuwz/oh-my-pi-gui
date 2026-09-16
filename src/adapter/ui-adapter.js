/**
 * Private, version-limited UI binding adapter.
 *
 * Pi 0.85.1 keeps exactly one UI context per runner and hands it to every extension
 * through `ctx.ui`. `ExtensionRunner.setUIContext()` wraps whatever context it is
 * given with `withUIPrompt`, which emits the host's own `ui_prompt_start` /
 * `ui_prompt_end` notifications (coalescing concurrent and nested prompts into one
 * outer waiting span).
 *
 * This adapter therefore does NOT overwrite the wrapper. It rebinds the runner to a
 * *bridge context* whose five blocking dialog methods resolve through browser answers,
 * and lets the host wrap that context again. Every other UI method is forwarded
 * unchanged, so `notify`, `setStatus`, widgets, theme and non-dialog behaviour stay
 * exactly as Pi provides them, and the lifecycle notifications remain host-emitted —
 * nothing is fabricated on `pi.events`.
 */

import { fingerprintUiPromptContext } from "./compat.js";

export const CUSTOM_UNSUPPORTED_MESSAGE =
	"ctx.ui.custom (custom terminal component prompts) is not supported in the browser UI. " +
	"The interaction failed without approval: no terminal fallback and no invented answer.";

const DIALOG_KINDS = ["confirm", "select", "input", "editor"];

/**
 * Bind the five blocking dialogs of the live runner to the browser bridge.
 *
 * @param {object} options
 * @param {object} options.runner live ExtensionRunner instance
 * @param {import("../core/request-store.js").RequestStore} options.store
 * @param {string} [options.mode]
 * @returns {{ ok: boolean, errors: string[], bridgeContext?: object, hostContext?: object, reboundContext?: object, restore?: () => void, verifyBinding?: (uiContext: object) => { ok: boolean, reason?: string } }}
 */
export function bindBrowserPrompts({ runner, store, mode = "tui", logger = () => {} }) {
	const errors = [];
	if (!runner || typeof runner.setUIContext !== "function" || typeof runner.getUIContext !== "function") {
		return { ok: false, errors: ["the host ExtensionRunner does not expose setUIContext/getUIContext"] };
	}

	const hostContext = runner.getUIContext();
	if (!hostContext || typeof hostContext !== "object") {
		return { ok: false, errors: ["ctx.ui is not available in this host mode"] };
	}
	const hostFingerprint = fingerprintUiPromptContext(hostContext);
	if (!hostFingerprint.ok) {
		return {
			ok: false,
			errors: [
				"the host UI context does not look like Pi 0.85.1's withUIPrompt wrapper, so the lifecycle can not be preserved",
				...hostFingerprint.errors,
			],
		};
	}

	let active = true;
	let reboundContext = null;

	function assertActive(kind) {
		if (!active) {
			throw new Error(
				`browser UI: the ${kind} prompt was requested after the browser bridge detached (reload or shutdown). ` +
					"It was not sent to the terminal and was not approved.",
			);
		}
		if (runner.getUIContext() !== reboundContext) {
			throw new Error(
				`browser UI: the ${kind} prompt was requested against a stale UI context (the host rebound extensions). ` +
					"It was not sent to the terminal and was not approved.",
			);
		}
	}

	function request(kind, payload) {
		assertActive(kind);
		const { promise } = store.create({ kind, ...payload });
		return promise;
	}

	const bridged = {
		confirm: (title, message, opts) =>
			request("confirm", { title, message, timeoutMs: opts?.timeout, signal: opts?.signal }),
		select: (title, options, opts) =>
			request("select", { title, options, timeoutMs: opts?.timeout, signal: opts?.signal }),
		input: (title, placeholder, opts) =>
			request("input", { title, placeholder, timeoutMs: opts?.timeout, signal: opts?.signal }),
		editor: (title, prefill) => request("editor", { title, prefill }),
		custom: () => {
			assertActive("custom");
			const noticeId = store.createUnsupportedNotice({
				title: "Custom terminal component prompt (ctx.ui.custom)",
				message: CUSTOM_UNSUPPORTED_MESSAGE,
			});
			logger(`unsupported ctx.ui.custom prompt reported in the browser as notice ${noticeId}`);
			return Promise.reject(new Error(`${CUSTOM_UNSUPPORTED_MESSAGE} (browser notice ${noticeId})`));
		},
	};
	// Forward every other UI method untouched; only the five blocking dialogs change.
	const bridgeContext = { ...hostContext, ...bridged };

	runner.setUIContext(bridgeContext, mode);
	reboundContext = runner.getUIContext();
	const reboundFingerprint = fingerprintUiPromptContext(reboundContext);
	if (reboundContext === hostContext) {
		errors.push("the host did not replace the UI context, so Pi's prompt lifecycle wrapper would be bypassed");
	}
	if (!reboundContext || typeof reboundContext !== "object") {
		errors.push("the host did not return a UI context after rebinding");
	} else if (!reboundFingerprint.ok) {
		errors.push("the rebound UI context is not wrapped by Pi's withUIPrompt lifecycle wrapper", ...reboundFingerprint.errors);
	}
	for (const kind of [...DIALOG_KINDS, "custom"]) {
		if (reboundContext?.[kind] === hostContext?.[kind]) {
			errors.push(`ctx.ui.${kind} was not rebound through the host wrapper`);
		}
	}

	if (errors.length > 0) {
		active = false;
		try {
			runner.setUIContext(hostContext, mode);
		} catch {
			// best effort rollback; the caller reports the failure and does not enable the GUI
		}
		return { ok: false, errors, hostContext, bridgeContext, reboundContext: null };
	}

	logger(`browser UI bound to the host wrapper over a bridge context (${Object.keys(bridged).length} dialogs)`);
	return {
		ok: true,
		errors: [],
		hostContext,
		bridgeContext,
		reboundContext,
		bridgedKinds: Object.keys(bridged),
		/** Live binding check against a UI context obtained from a fresh ctx. */
		verifyBinding: (uiContext) => {
			if (!active) {
				return { ok: false, reason: "the browser bridge is detached" };
			}
			if (uiContext && uiContext !== reboundContext) {
				return { ok: false, reason: "ctx.ui is not the context this bridge bound" };
			}
			if (runner.getUIContext() !== reboundContext) {
				return { ok: false, reason: "the host rebound extensions to another UI context" };
			}
			const live = fingerprintUiPromptContext(reboundContext);
			return live.ok ? { ok: true } : { ok: false, reason: `host prompt wrapper check failed: ${live.errors[0] ?? "unknown"}` };
		},
		/** Refuse further prompts without touching the host context (reload / shutdown). */
		deactivate: () => {
			active = false;
		},
		/** Hand the host back its own context (explicit stop; not used on reload). */
		restore: () => {
			if (!active) {
				return;
			}
			active = false;
			try {
				runner.setUIContext(hostContext, mode);
			} catch {
				// the runner may already be torn down during shutdown
			}
		},
	};
}
