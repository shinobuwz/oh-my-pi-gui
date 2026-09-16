/**
 * Real CLI checks against the installed Pi distribution.
 *
 * 1. The shipped CLI loads this repository's extension and registers its command
 *    (isolated config dir, RPC mode, `--no-session --offline`, no prompt, no model call).
 * 2. The private UI seam is verified in the *bundled* runtime: the production adapter
 *    resolves the running package's absolute bundle entry, while a repository-local
 *    probe proves the live `ExtensionRunner` is captured, rebinding keeps Pi's
 *    `withUIPrompt` wrapper, and the host itself emits `ui_prompt_start`/`ui_prompt_end`.
 *
 * The bundled CLI is only ever started as a child process; it is never imported here,
 * because importing it would boot the user's extensions inside the test process.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ADAPTER_ENTRY, REPO_ROOT, URL_FILE, locateHostPackage } from "./helpers/host.js";

const CAPTURE_PROBE_ENTRY = join(REPO_ROOT, "test", "fixtures", "capture-probe.js");
const SKIP = process.env.PI_BROWSER_UI_SKIP_CLI_TEST === "1";

function resolveCliEntry() {
	try {
		const host = locateHostPackage();
		const entry = join(host.packageRoot, "dist", "bundle", "cli.js");
		return existsSync(entry) ? entry : null;
	} catch {
		return null;
	}
}

/** Run the CLI in RPC mode and exchange one JSON request. */
function runRpcRequest({ cliEntry, request, responseId, timeoutMs = 20000 }) {
	return new Promise((resolve, reject) => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-browser-ui-agent-"));
		const child = spawn(process.execPath, [cliEntry, "--mode", "rpc", "--no-extensions", "-e", ADAPTER_ENTRY, "--no-session", "--offline"], {
			cwd: REPO_ROOT,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buffer = "";
		let settled = false;
		const finish = (error, value) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			child.kill();
			rmSync(agentDir, { recursive: true, force: true });
			if (error) {
				reject(error);
			} else {
				resolve(value);
			}
		};
		const timer = setTimeout(() => finish(new Error(`no response to ${request.type} within ${timeoutMs}ms`)), timeoutMs);
		child.on("error", (error) => finish(error));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (!line) {
					continue;
				}
				try {
					const message = JSON.parse(line);
					if (message.id === responseId) {
						finish(null, message);
						return;
					}
				} catch {
					// Partial or non-JSON output; keep reading.
				}
			}
		});
		child.stdin.write(`${JSON.stringify(request)}\n`);
	});
}

/**
 * Probe extension that mirrors the production seam: dynamic import of the host
 * package, prototype capture of the live runner, rebinding through setUIContext and a
 * check that the host wraps the bridge context and emits the lifecycle events itself.
 */
function writeCaptureProbe(dir, outputPath) {
	const probePath = join(dir, "capture-probe.js");
	const source = `import { appendFileSync } from "node:fs";
const OUT = ${JSON.stringify(outputPath)};
const log = (line) => appendFileSync(OUT, line + "\\n");
const state = (globalThis.__probe ??= { hits: 0, runner: null });
export default async function probe(pi) {
	const module = await import("@earendil-works/pi-coding-agent");
	const Runner = module.ExtensionRunner;
	const original = Runner.prototype.setUIContext;
	Runner.prototype.setUIContext = function (...args) {
		state.hits += 1;
		state.runner = this;
		return original.apply(this, args);
	};
	const events = [];
	pi.on("ui_prompt_start", (event) => events.push("start:" + event.kind));
	pi.on("ui_prompt_end", (event) => events.push("end:" + event.kind));
	pi.on("session_start", async (_event, ctx) => {
		log("captured=" + Boolean(state.runner) + " hits=" + state.hits + " mode=" + ctx.mode);
		if (!state.runner) { return; }
		const before = state.runner.getUIContext();
		state.runner.setUIContext({ ...before, confirm: async () => "BRIDGE" }, "tui");
		const after = state.runner.getUIContext();
		log("rebound=" + (after !== before) + " hostWrapper=" + String(after.confirm).includes('withUIPrompt("confirm"'));
		const answer = await state.runner.createContext().ui.confirm("probe", "probe");
		log("answer=" + answer + " events=" + JSON.stringify(events));
	});
}
`;
	writeFileSync(probePath, source, { encoding: "utf8" });
	return probePath;
}

/** Run the temporary capture probe in the real bundled CLI and return its log. */
function runCaptureProbe({ cliEntry, timeoutMs = 30000 }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-browser-ui-probe-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-browser-ui-agent-"));
	const outputPath = join(dir, "probe.log");
	writeFileSync(outputPath, "");
	const probePath = writeCaptureProbe(dir, outputPath);
	const child = spawn(process.execPath, [cliEntry, "--mode", "rpc", "--no-extensions", "-e", probePath, "--no-session", "--offline"], {
		cwd: REPO_ROOT,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const cleanup = () => {
		child.kill();
		rmSync(dir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	};
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const poll = setInterval(() => {
			const log = readFileSync(outputPath, "utf8");
			if (log.includes("events=")) {
				clearInterval(poll);
				cleanup();
				resolve(log);
				return;
			}
			if (Date.now() > deadline) {
				clearInterval(poll);
				cleanup();
				reject(new Error(`capture probe produced no result within ${timeoutMs}ms: ${log || "(empty)"}`));
			}
		}, 100);
	});
}

/** Run the production adapter plus the repository-local capture probe in the bundled CLI. */
function runRepositoryCaptureProbe({ cliEntry, timeoutMs = 30000 }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-browser-ui-repo-probe-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-browser-ui-agent-"));
	const outputPath = join(dir, "probe.log");
	writeFileSync(outputPath, "");
	const child = spawn(
		process.execPath,
		[cliEntry, "--mode", "rpc", "--no-extensions", "-e", ADAPTER_ENTRY, "-e", CAPTURE_PROBE_ENTRY, "--no-session", "--offline"],
		{
			cwd: REPO_ROOT,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_BROWSER_UI_CAPTURE_PROBE_LOG: outputPath },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const cleanup = () => {
		child.kill();
		rmSync(dir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	};
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const poll = setInterval(() => {
			const log = readFileSync(outputPath, "utf8");
			if (log.includes("answer=BRIDGE")) {
				clearInterval(poll);
				cleanup();
				resolve(log);
				return;
			}
			if (Date.now() > deadline) {
				clearInterval(poll);
				cleanup();
				reject(new Error(`repository capture probe produced no result within ${timeoutMs}ms: ${log || "(empty)"}`));
			}
		}, 100);
	});
}

describe("real CLI extension load", () => {
	it("loads this extension and registers its command in the installed Pi runtime", async (t) => {
		const cliEntry = resolveCliEntry();
		if (SKIP || !cliEntry) {
			t.skip(SKIP ? "PI_BROWSER_UI_SKIP_CLI_TEST=1" : "installed Pi CLI entry not found");
			return;
		}
		const response = await runRpcRequest({
			cliEntry,
			request: { id: "req-commands", type: "get_commands" },
			responseId: "req-commands",
		});
		assert.equal(response.success, true, JSON.stringify(response).slice(0, 300));
		const command = response.data.commands.find((entry) => entry.name === "browser-ui");
		assert.ok(command, `browser-ui must be registered, got: ${response.data.commands.map((entry) => entry.name).join(", ")}`);
		assert.equal(command.source, "extension");
		assert.equal(command.sourceInfo.path, ADAPTER_ENTRY);
		assert.equal(existsSync(URL_FILE), false, "RPC mode must not start the bridge");
	});

	it("keeps the temporary probe coverage for the bundled host wrapper", async (t) => {
		const cliEntry = resolveCliEntry();
		if (SKIP || !cliEntry) {
			t.skip(SKIP ? "PI_BROWSER_UI_SKIP_CLI_TEST=1" : "installed Pi CLI entry not found");
			return;
		}
		const log = await runCaptureProbe({ cliEntry });
		assert.match(log, /captured=true hits=[1-9]/, `the extension must capture the live ExtensionRunner in the bundled runtime: ${log}`);
		assert.match(log, /rebound=true/, "the bridge context must replace the host UI context");
		assert.match(log, /hostWrapper=true/, "the rebound context must be wrapped by Pi's withUIPrompt");
		assert.match(log, /answer=BRIDGE/, "consumer dialogs must resolve through the bridge context");
		assert.match(log, /events=\["start:confirm","end:confirm"\]/, "the host itself must emit the prompt lifecycle events");
	});

	it("installs production capture from a repository-local fixture in the bundled runtime", async (t) => {
		const cliEntry = resolveCliEntry();
		if (SKIP || !cliEntry) {
			t.skip(SKIP ? "PI_BROWSER_UI_SKIP_CLI_TEST=1" : "installed Pi CLI entry not found");
			return;
		}
		const log = await runRepositoryCaptureProbe({ cliEntry });
		assert.match(log, /patchInstalled=true captures=[1-9] source=bundle/, `production capture must bind the running bundled class: ${log}`);
		assert.match(log, /rebound=true/, "the bridge context must replace the host UI context");
		assert.match(log, /hostWrapper=true/, "the rebound context must be wrapped by Pi's withUIPrompt");
		assert.match(log, /answer=BRIDGE/, "consumer dialogs must resolve through the bridge context");
		assert.match(log, /events=\["start:confirm","end:confirm"\]/, "the host itself must emit the prompt lifecycle events");
	});
});
