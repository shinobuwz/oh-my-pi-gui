/**
 * Compatibility gating: the prototype must refuse to enable a half-working GUI when
 * the host version or the private UI seam does not match, instead of silently
 * degrading to terminal interaction.
 */

import assert from "node:assert/strict";
import { after, before, afterEach, describe, it } from "node:test";
import { join } from "node:path";

import {
	REPO_ROOT,
	URL_FILE_ENV,
	createFakeHostPackage,
	createHarness,
	locateHostPackage,
	readBridgeUrl,
	resetBridgeProcessState,
} from "./helpers/host.js";
import { SUPPORTED_HOST_VERSION, checkCompatibility, fingerprintUiPromptContext, versionCheck } from "../src/adapter/compat.js";

const URL_FILE = join(REPO_ROOT, ".browser-ui", `url-compat-${process.pid}`);
process.env[URL_FILE_ENV] = URL_FILE;

let host;
const cleanups = [];

before(() => {
	host = locateHostPackage();
});

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()();
	}
});

after(() => {
	delete process.env.PI_BROWSER_UI_PACKAGE_ROOT;
});

async function harnessWithHost(packageRoot, options = {}) {
	await resetBridgeProcessState(URL_FILE);
	process.env.PI_BROWSER_UI_PACKAGE_ROOT = packageRoot;
	const harness = await createHarness({ packageRoot: host.packageRoot, ...options });
	cleanups.push(async () => {
		await harness.runner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
		await resetBridgeProcessState(URL_FILE);
	});
	return harness;
}

function listeningSockets() {
	return process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;
}

describe("compatibility checks", () => {
	it("accepts the exact supported version", () => {
		const result = versionCheck(SUPPORTED_HOST_VERSION);
		assert.equal(result.ok, true);
		assert.equal(result.actual, SUPPORTED_HOST_VERSION);
	});

	it("rejects other versions", () => {
		const result = versionCheck("0.86.0");
		assert.equal(result.ok, false);
		assert.match(result.error, /0\.86\.0 is not supported/);
	});

	it("detects a UI context that is not Pi's withUIPrompt wrapper", () => {
		const raw = { select: () => {}, confirm: () => {}, input: () => {}, editor: () => {}, custom: () => {} };
		const fingerprint = fingerprintUiPromptContext(raw);
		assert.equal(fingerprint.ok, false);
		assert.equal(fingerprint.errors.length >= 5, true);
		assert.match(fingerprint.errors[0], /withUIPrompt wrapper/);

		const report = checkCompatibility({ uiContext: raw, hostPackage: { version: SUPPORTED_HOST_VERSION, source: "test" } });
		assert.equal(report.ok, false);
	});
});

describe("refusal on host mismatch", () => {
	it("does not enable the bridge for an unsupported Pi version", async () => {
		const fake = createFakeHostPackage({ version: "0.84.0" });
		cleanups.push(fake.cleanup);
		const harness = await harnessWithHost(fake.dir);
		const socketsBefore = listeningSockets();
		const originalConfirm = harness.runner.getUIContext().confirm;

		await harness.runner.emit({ type: "session_start", reason: "startup" });

		const messages = harness.poisoned.notifications.map((entry) => entry.message).join(" | ");
		assert.match(messages, /0\.84\.0 is not supported/);
		assert.match(messages, new RegExp(SUPPORTED_HOST_VERSION.replace(/\./g, "\\.")));
		assert.equal(listeningSockets(), socketsBefore, "no bridge port may be opened when the host is unsupported");
		assert.equal(harness.runner.getUIContext().confirm, originalConfirm, "the bound context must stay the host wrapper");
		assert.throws(
			() => harness.runner.getUIContext().confirm("x", "y"),
			/terminal confirm dialog must not be reached/,
			"prompts must keep using the host path when the browser UI refuses to enable",
		);
		assert.equal(readBridgeUrl(), null, "no browser entry point may be published");
	});

	it("does not enable the bridge when the host UI seam changed", async () => {
		const harness = await harnessWithHost(host.packageRoot);
		const uiContext = harness.runner.getUIContext();
		// Simulate a host whose ctx.ui is not the withUIPrompt wrapper, as a future
		// Pi version might provide it. The adapter must refuse rather than bind blindly.
		const originalConfirm = uiContext.confirm;
		uiContext.confirm = () => Promise.resolve(false);

		await harness.runner.emit({ type: "session_start", reason: "startup" });

		const messages = harness.poisoned.notifications.map((entry) => entry.message).join(" | ");
		assert.match(messages, /refuses to enable/);
		assert.match(messages, /withUIPrompt wrapper/);
		assert.equal(readBridgeUrl(), null);
		assert.equal(uiContext.confirm !== originalConfirm, true, "the adapter must not rewrite the foreign method");
	});

	it("explains how to point the prototype at a non-standard installation", async () => {
		const fake = createFakeHostPackage({ version: SUPPORTED_HOST_VERSION, name: "not-pi" });
		cleanups.push(fake.cleanup);
		const harness = await harnessWithHost(fake.dir);

		await harness.runner.emit({ type: "session_start", reason: "startup" });

		const messages = harness.poisoned.notifications.map((entry) => entry.message).join(" | ");
		assert.match(messages, /could not locate the running @earendil-works\/pi-coding-agent installation/);
		assert.match(messages, /PI_BROWSER_UI_PACKAGE_ROOT/);
		assert.equal(readBridgeUrl(), null);
	});
});

describe("positive control", () => {
	it("enables the bridge through the host prompt wrapper when the installed host matches", async () => {
		const harness = await harnessWithHost(host.packageRoot);
		await harness.runner.emit({ type: "session_start", reason: "startup" });
		assert.match(harness.poisoned.notifications[0].message, /Browser UI ready/);
		assert.ok(readBridgeUrl());
		const bound = harness.runner.getUIContext();
		assert.equal(harness.runner.createContext().ui, bound, "ctx.ui must be the rebound context");
		assert.match(String(bound.confirm), /withUIPrompt\("confirm"/, "consumers must keep Pi's prompt lifecycle wrapper");
		assert.notEqual(bound.confirm, harness.poisoned.uiContext.confirm, "the terminal dialog must not be reachable");
		assert.deepEqual(harness.poisoned.dialogCalls, []);
	});

	it("refuses to enable when the live runner can never be captured", async () => {
		const harness = await harnessWithHost(host.packageRoot, { installCapture: false });
		await harness.runner.emit({ type: "session_start", reason: "startup" });
		const messages = harness.poisoned.notifications.map((entry) => entry.message);
		assert.match(messages.join(" | "), /could not be captured/);
		assert.match(messages.join(" | "), /captured 0 bind\(s\) after [1-9]\d* candidate attempt\(s\)/);
		assert.equal(readBridgeUrl(), null, "no bridge may be opened without a verified runner binding");
		// Without a captured runner nothing is rebound: prompts still take the host path.
		assert.throws(
			() => harness.runner.getUIContext().confirm("x", "y"),
			/terminal confirm dialog must not be reached/,
			"a capture failure must not silently produce a half-working GUI",
		);
	});
});
