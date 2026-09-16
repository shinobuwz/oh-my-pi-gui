/**
 * Version and binding checks for the private UI seam.
 *
 * The prototype only supports the exact Pi version it was written against and only
 * when the host UI context still exposes the `withUIPrompt` dialog wrapper. Class or
 * bundle identity alone is never treated as proof: the checks inspect the actual
 * object other extensions receive through `ctx.ui`, and the adapter re-verifies the
 * live binding before every browser prompt.
 */

export const SUPPORTED_HOST_VERSION = "0.85.1";

/** Dialog methods the browser adapter replaces, in the order Pi wraps them. */
export const DIALOG_KINDS = Object.freeze(["select", "confirm", "input", "editor", "custom"]);

function sourceOf(fn) {
	try {
		return Function.prototype.toString.call(fn);
	} catch {
		return "";
	}
}

/**
 * Verify that `uiContext` is Pi's withUIPrompt wrapper (not a raw/no-op UI context).
 * Checked per method: present, delegates through `withUIPrompt("<kind>"`, and
 * forwards to the underlying `ui.<kind>` implementation.
 */
export function fingerprintUiPromptContext(uiContext) {
	const kinds = {};
	const errors = [];
	for (const kind of DIALOG_KINDS) {
		const fn = uiContext?.[kind];
		const present = typeof fn === "function";
		const source = present ? sourceOf(fn) : "";
		const callsWithUIPrompt = source.includes(`withUIPrompt("${kind}"`);
		const delegatesToUi = source.includes(`ui.${kind}`);
		kinds[kind] = { present, callsWithUIPrompt, delegatesToUi };
		if (!present) {
			errors.push(`ctx.ui.${kind} is not a function`);
			continue;
		}
		if (!callsWithUIPrompt) {
			errors.push(`ctx.ui.${kind} does not look like Pi's withUIPrompt wrapper (missing withUIPrompt("${kind}") call)`);
		}
		if (!delegatesToUi) {
			errors.push(`ctx.ui.${kind} does not forward to an underlying ui.${kind} implementation`);
		}
	}
	return { ok: errors.length === 0, kinds, errors };
}

export function versionCheck(version) {
	const ok = version === SUPPORTED_HOST_VERSION;
	return {
		ok,
		expected: SUPPORTED_HOST_VERSION,
		actual: typeof version === "string" ? version : null,
		error: ok ? null : `host Pi version ${String(version)} is not supported (this prototype is limited to ${SUPPORTED_HOST_VERSION})`,
	};
}

/**
 * Full pre-enable check.
 *
 * @returns {{ ok: boolean, errors: string[], version: string | null, versionCheck: object, fingerprint: object, hostSource: string }}
 */
export function checkCompatibility({ uiContext, hostPackage }) {
	const errors = [];
	const version = hostPackage?.version ?? null;
	const versionResult = versionCheck(version);
	if (!versionResult.ok) {
		errors.push(versionResult.error);
	}
	const fingerprint = fingerprintUiPromptContext(uiContext);
	errors.push(...fingerprint.errors);
	return {
		ok: errors.length === 0,
		errors,
		version,
		versionCheck: versionResult,
		fingerprint,
		hostSource: hostPackage?.source ?? "unknown",
	};
}
