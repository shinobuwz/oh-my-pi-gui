/**
 * Test fixture: observes the production runner-capture hook from a repository-local
 * extension. Keeping this module in the repository is intentional: a temporary probe
 * is resolved from a different module context and does not reproduce the real defect.
 */

import { appendFileSync } from "node:fs";

import { captureInfo, capturedRunner } from "../../src/adapter/runner-capture.js";

const OUTPUT = process.env.PI_BROWSER_UI_CAPTURE_PROBE_LOG;

function log(line) {
	if (!OUTPUT) {
		throw new Error("PI_BROWSER_UI_CAPTURE_PROBE_LOG is required by capture-probe");
	}
	appendFileSync(OUTPUT, `${line}\n`, "utf8");
}

export default function captureProbe(pi) {
	const events = [];
	pi.on("ui_prompt_start", (event) => events.push(`start:${event.kind}`));
	pi.on("ui_prompt_end", (event) => events.push(`end:${event.kind}`));
	pi.on("session_start", async (_event, ctx) => {
		const info = captureInfo();
		log(
			`patchInstalled=${info.patchInstalled} captures=${info.captures} source=${info.source ?? "(none)"} attempts=${info.attempts} mode=${ctx.mode} error=${info.error ?? "(none)"}`,
		);
		const runner = capturedRunner();
		if (!runner) {
			log("runner=false");
			return;
		}

		const before = runner.getUIContext();
		runner.setUIContext({ ...before, confirm: async () => "BRIDGE" }, "tui");
		const after = runner.getUIContext();
		log(
			`rebound=${after !== before} hostWrapper=${String(after.confirm).includes('withUIPrompt("confirm"')}`,
		);
		const answer = await runner.createContext().ui.confirm("capture probe", "capture probe");
		log(`answer=${answer} events=${JSON.stringify(events)}`);
	});
}
