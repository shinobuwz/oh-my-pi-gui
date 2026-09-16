/**
 * Diagnostic for the real, installed questionnaire tool.
 *
 * Status of this spike: questionnaire adaptation is BLOCKED. The installed
 * questionnaire asks through `ctx.ui.custom(...)`, whose component closure owns the
 * questions, options and answers. Within the approved private-UI boundary there is no
 * seam that can read or answer that component, so the prototype reports the
 * interaction in the browser as unsupported and terminates it without approval.
 *
 * This test exists to keep that claim honest and reproducible. It only runs when
 * PI_BROWSER_UI_QUESTIONNAIRE_PATH points at a read-only copy of the installed
 * questionnaire; the repository never hardcodes a personal installation path and
 * nothing here writes to that file.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";

import {
	REPO_ROOT,
	URL_FILE_ENV,
	bridgeClient,
	createHarness,
	locateHostPackage,
	readBridgeUrl,
	splitUrl,
	toolDefinition,
} from "./helpers/host.js";

const QUESTIONNAIRE_PATH = process.env.PI_BROWSER_UI_QUESTIONNAIRE_PATH ?? "";
const URL_FILE = join(REPO_ROOT, ".browser-ui", `url-questionnaire-${process.pid}`);
process.env[URL_FILE_ENV] = URL_FILE;

const runnable = QUESTIONNAIRE_PATH.length > 0 && existsSync(QUESTIONNAIRE_PATH);
const skipReason = runnable
	? false
	: "set PI_BROWSER_UI_QUESTIONNAIRE_PATH to the installed questionnaire.ts to run this diagnostic";

let harness;

before(async () => {
	if (!runnable) {
		return;
	}
	const host = locateHostPackage();
	process.env.PI_BROWSER_UI_PACKAGE_ROOT = host.packageRoot;
	harness = await createHarness({ packageRoot: host.packageRoot, extraExtensions: [QUESTIONNAIRE_PATH] });
	await harness.runner.emit({ type: "session_start", reason: "startup" });
});

after(async () => {
	if (harness) {
		await harness.runner.emit({ type: "session_shutdown", reason: "quit" });
	}
});

describe("installed questionnaire under the prototype", () => {
	it("cannot be answered from the browser and terminates without approval", { skip: skipReason }, async () => {
		const bridge = bridgeClient(splitUrl(readBridgeUrl()));
		const tool = toolDefinition(harness.modules, harness.runner, "questionnaire");
		let failure = null;
		try {
			await tool.execute("questionnaire-call", {
				questions: [
					{
						id: "scope",
						prompt: "Which scope should the work cover?",
						options: [
							{ value: "prototype", label: "Prototype only" },
							{ value: "mvp", label: "Full MVP" },
						],
					},
					{
						id: "priority",
						prompt: "What matters most?",
						options: [{ value: "speed", label: "Speed" }],
						allowOther: true,
					},
				],
			});
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		}

		assert.ok(failure, "the questionnaire must not silently produce answers without a browser answer path");
		assert.match(failure.message, /not supported in the browser UI/);
		assert.match(failure.message, /failed without approval/);
		assert.deepEqual(harness.poisoned.dialogCalls, [], "the questionnaire must not render a terminal component");

		const snapshot = await bridge.state();
		const notice = snapshot.pending.find((request) => request.unsupported);
		assert.ok(notice, "the browser must be told that the interaction is unsupported");
		assert.match(notice.message, /failed without approval/);

		// The browser has no way to approve or answer this interaction.
		const attempt = await bridge.answer(notice.id, "prototype");
		assert.equal(attempt.status, 409);
		assert.equal(attempt.payload.error.code, "unsupported_request");
		assert.equal((await bridge.state()).pending.some((request) => !request.unsupported), false);
	});
});
