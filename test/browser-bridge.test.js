/**
 * Adapter seam checks for `src/adapter/browser-bridge.js`.
 *
 * The loopback server only proves a real client can reach it when the bridge hands
 * its own fetch seam (and its diagnostics) through to `startBridgeServer`. These
 * tests run the real adapter against a fake host package and a fake runner whose UI
 * context carries Pi's `withUIPrompt` shape, so deleting the fetch passthrough or the
 * `info().bindingDiagnostics` exposure fails here even though the plain core-level
 * bridge tests keep working.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { BrowserBridge } from "../src/adapter/browser-bridge.js";
import { PACKAGE_ROOT_ENV } from "../src/adapter/host-package.js";
import { createFakeHostPackage, resetBridgeProcessState } from "./helpers/host.js";

const ASSETS_DIR = fileURLToPath(new URL("../src/browser/", import.meta.url));

/** Stand-in for Pi's own `withUIPrompt`; only the source shape is inspected. */
function withUIPrompt(_kind, run) {
	return run();
}

/** A host UI context that carries the wrapper shape `fingerprintUiPromptContext` checks. */
function createHostUiContext() {
	const ui = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
		notify: () => {},
	};
	return {
		...ui,
		select: (...args) => withUIPrompt("select", () => ui.select(...args)),
		confirm: (...args) => withUIPrompt("confirm", () => ui.confirm(...args)),
		input: (...args) => withUIPrompt("input", () => ui.input(...args)),
		editor: (...args) => withUIPrompt("editor", () => ui.editor(...args)),
		custom: (...args) => withUIPrompt("custom", () => ui.custom(...args)),
	};
}

/** Minimal ExtensionRunner: `setUIContext` wraps the given context like Pi does. */
function createFakeRunner() {
	let uiContext = createHostUiContext();
	return {
		getUIContext: () => uiContext,
		setUIContext: (context) => {
			const ui = context;
			uiContext = {
				...context,
				select: (...args) => withUIPrompt("select", () => ui.select(...args)),
				confirm: (...args) => withUIPrompt("confirm", () => ui.confirm(...args)),
				input: (...args) => withUIPrompt("input", () => ui.input(...args)),
				editor: (...args) => withUIPrompt("editor", () => ui.editor(...args)),
				custom: (...args) => withUIPrompt("custom", () => ui.custom(...args)),
			};
			return uiContext;
		},
		onError: () => () => {},
	};
}

let fakeHost;

before(async () => {
	await resetBridgeProcessState();
	fakeHost = createFakeHostPackage({ version: "0.85.1" });
});

after(async () => {
	await resetBridgeProcessState();
	fakeHost?.cleanup();
});

describe("browser bridge adapter seam", () => {
	it("forwards the injected fetch into the self-check and exposes binding diagnostics through info()", async () => {
		const fetchCalls = [];
		const injectedFetch = async (url, options) => {
			fetchCalls.push({ url, options });
			return { status: 200 };
		};
		const bridge = new BrowserBridge({
			assetsDir: ASSETS_DIR,
			logger: () => {},
			env: { [PACKAGE_ROOT_ENV]: fakeHost.dir },
			argv: ["node", "test"],
			urlFile: null,
			fetch: injectedFetch,
		});
		try {
			const info = await bridge.attach({ runner: createFakeRunner(), mode: "tui" });

			assert.equal(info.running, true);
			assert.equal(info.port > 0, true);
			assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}$/, "the attached bridge must publish its URL");

			assert.equal(fetchCalls.length, 1, "browser-bridge must pass its injected fetch seam to the bound-client self-check");
			assert.equal(fetchCalls[0].url, `http://127.0.0.1:${info.port}/api/state`);
			assert.equal(
				fetchCalls[0].options.headers.Authorization,
				`Bearer ${bridge.registry.server.token}`,
				"the self-check must authenticate with the bridge token",
			);
			assert.equal(fetchCalls[0].options.redirect, "manual");
			assert.ok(fetchCalls[0].options.signal instanceof AbortSignal, "the self-check must carry a bounded signal");

			assert.equal(info.bindingDiagnostics?.selfCheck?.outcome, "reachable", "info() must expose the binding diagnostics");
			assert.equal(info.bindingDiagnostics.selfCheck.port, info.port);
			assert.equal(info.bindingDiagnostics.attempts.length, 1);
			assert.equal(info.bindingDiagnostics.attempts[0].outcome, "reachable");
			assert.equal(info.bindingDiagnostics.attempts[0].selfCheck, info.bindingDiagnostics.selfCheck);
			assert.match(bridge.logTail(10).join("\n"), /client self-check passed/, "the shared bridge log must record the self-check");
		} finally {
			await bridge.stop("test");
		}
	});
});
