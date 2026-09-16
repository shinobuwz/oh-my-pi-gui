/**
 * Opt-in real-SDK smoke test.
 *
 * Runs against the installed Pi package (resolved exactly like the launcher does) and
 * proves that `createAgentSession` + `bindExtensions({ uiContext, mode: "tui" })` can
 * load a real extension through Pi's resource loader and that the extension calls our
 * UI context. It never prompts the model and writes sessions only into a temporary
 * session directory, so the user's session directory and configuration are untouched.
 *
 * Skipped by default: set `PI_GUI_SMOKE=1` to run it. `PI_GUI_SMOKE_AGENT_DIR` can
 * override the agent directory that the temporary resource loader reads (read-only).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { RequestStore } from "../src/core/request-store.js";
import { HostChatBridge } from "../src/host/chat.js";
import { HostModelBridge } from "../src/host/models.js";
import { loadHostSdk } from "../src/host/sdk-loader.js";
import { HostStatusBridge } from "../src/host/status.js";
import { HostSubagentsBridge, openSubagentsChannel } from "../src/host/subagents.js";
import { createBrowserUIContext } from "../src/host/ui-context.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROBE_FIXTURE = resolve(fileURLToPath(new URL("./fixtures/ui-probe-extension.js", import.meta.url)));
const SMOKE_ENABLED = process.env.PI_GUI_SMOKE === "1";
/** Installed pi-subagents entry used by the read-only channel smoke test (overridable). */
const SUBAGENTS_ENTRY = process.env.PI_GUI_SMOKE_SUBAGENTS_PATH?.trim()
	|| join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents", "index.ts");

function isInside(child, parent) {
	const normalize = (value) => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value));
	const normalizedParent = normalize(parent);
	const normalizedChild = normalize(child);
	return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`);
}

describe("real Pi SDK smoke (opt-in)", () => {
	it(
		"binds our UI context in tui mode and observes a real extension calling it",
		{ skip: SMOKE_ENABLED ? false : "set PI_GUI_SMOKE=1 to run against the installed Pi SDK" },
		async () => {
			const loaded = await loadHostSdk({ env: process.env });
			assert.equal(loaded.error, undefined, `the installed SDK must resolve: ${loaded.error ?? ""}`);
			const { sdk } = loaded;
			assert.equal(typeof sdk.DefaultResourceLoader, "function", "DefaultResourceLoader must be part of the public SDK");

			const tmp = mkdtempSync(join(tmpdir(), "pi-gui-smoke-"));
			const sessionDir = join(tmp, "sessions");
			const agentDir = process.env.PI_GUI_SMOKE_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
			try {
				// Load only the probe fixture: deterministic, and no user extension runs.
				const resourceLoader = new sdk.DefaultResourceLoader({
					cwd: REPO_ROOT,
					agentDir,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [PROBE_FIXTURE],
				});
				// A caller-provided resource loader must be reloaded by the caller.
				await resourceLoader.reload();
				const sessionManager = sdk.SessionManager.create(REPO_ROOT, sessionDir);
				const created = await sdk.createAgentSession({ cwd: REPO_ROOT, sessionManager, resourceLoader });
				const session = created.session;
				try {
					assert.equal(session.prompt !== undefined, true, "the public session API must be present");
					assert.equal(typeof session.bindExtensions, "function");
					assert.equal(created.extensionsResult.extensions.length >= 1, true, "the probe extension must be loaded");

					const store = new RequestStore();
					const uiContext = createBrowserUIContext({ store, logger: () => {} });
					await session.bindExtensions({ uiContext, mode: "tui" });

					assert.equal(uiContext.getStatuses().get("ui-probe"), "session_start", "the extension must call our UI context after binding");
					assert.equal(
						uiContext.getNotices().some((notice) => notice.message.includes("browser UI context")),
						true,
						"the extension notify must reach our UI context",
					);
					assert.equal(store.pendingCount, 0, "binding alone must not create browser prompts");

					// Work group 2 (chat): the public members the browser chat drives must exist on a
					// real session, and an unknown slash command must be refused before any prompt.
					for (const member of ["prompt", "abort", "subscribe"]) {
						assert.equal(typeof session[member], "function", `the public session API must expose ${member}()`);
					}
					assert.equal(typeof session.isIdle, "boolean", "the public isIdle getter must exist");
					assert.equal(typeof session.isStreaming, "boolean", "the public isStreaming getter must exist");
					assert.equal(typeof session.sessionManager.buildContextEntries, "function", "the public history accessor must exist");
					assert.equal(typeof session.sessionManager.getLeafId, "function");
					assert.equal(typeof session.extensionRunner.getRegisteredCommands, "function", "the public command catalog must exist");
					const chat = new HostChatBridge({ session, generation: 1, logger: () => {} });
					try {
						const snapshot = chat.snapshot();
						assert.equal(snapshot.available, true);
						assert.equal(snapshot.phase, "idle");
						assert.equal(snapshot.canSend, true);
						assert.deepEqual(snapshot.messages, [], "a fresh session has no active-branch history");
						assert.equal(snapshot.lastError, null);
						const refused = await chat.sendMessage(1, { generation: 1, text: "/definitely-not-a-command" });
						assert.equal(refused.code, "unsupported_command", "an unknown slash command must never reach the model");
						const oversized = await chat.sendMessage(1, { generation: 1, text: "x".repeat(70 * 1024) });
						assert.equal(oversized.code, "message_too_long");
						assert.equal(session.isIdle, true, "no refused request may start an agent run");
					} finally {
						chat.dispose();
					}

					// Work group 3 (model/thinking + status): the public members the browser controls and
					// the status panel read must exist on a real session, and both adapters must snapshot
					// it without a model call.
					for (const member of ["setModel", "setThinkingLevel", "getAvailableThinkingLevels", "getContextUsage"]) {
						assert.equal(typeof session[member], "function", `the public session API must expose ${member}()`);
					}
					assert.equal(Array.isArray(session.scopedModels), true, "the public scoped-model list must exist");
					assert.equal(typeof session.modelRuntime.getAvailableSnapshot, "function", "the public model runtime snapshot must exist");
					assert.equal(typeof session.sessionManager.getCwd, "function", "the public session cwd reader must exist");
					assert.equal(typeof session.sessionManager.getBranch, "function", "the public branch reader must exist");

					const modelBridge = new HostModelBridge({ session, generation: 1, logger: () => {} });
					try {
						const controls = modelBridge.snapshot();
						assert.equal(controls.available, true);
						assert.equal(typeof controls.model.provider, "string");
						assert.equal(typeof controls.model.id, "string");
						assert.equal(controls.thinkingLevels.length > 0, true, "a real session reports selectable thinking levels");
						assert.equal(controls.thinkingLevel !== null, true, "a real session reports its effective thinking level");
						assert.equal(Array.isArray(controls.candidates), true);
						for (const candidate of controls.candidates) {
							assert.equal(candidate.key, `${candidate.provider}/${candidate.id}`);
							assert.equal("baseUrl" in candidate, false, "no provider configuration may cross the boundary");
							assert.equal("apiKey" in candidate, false);
						}
						assert.equal(JSON.stringify(controls).includes("apiKey"), false);
						// A key outside the live allowlist must be refused before the session is asked.
						const refused = await modelBridge.selectModel(1, { generation: 1, key: "does-not-exist/model" });
						assert.equal(refused.code, "model_not_allowed");
					} finally {
						modelBridge.dispose();
					}

					const statusBridge = new HostStatusBridge({ session, generation: 1, logger: () => {}, execFile: () => ({ kill: () => {} }) });
					try {
						const status = statusBridge.snapshot();
						assert.equal(status.available, true);
						assert.equal(typeof status.cwd, "string", "the public session manager reports the session cwd");
						assert.equal(status.cwd.toLowerCase().includes("oh-my-pi-gui"), true, `the status cwd must be the session cwd (${status.cwd})`);
						assert.deepEqual(
							status.tokens,
							{ input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
							"a fresh session has no usage, so every total stays unknown instead of zero",
						);
						assert.equal(status.contextUsage === null || typeof status.contextUsage === "object", true);
					} finally {
						statusBridge.dispose();
					}

					const sessionFile = session.sessionManager.getSessionFile();
					assert.equal(typeof sessionFile, "string", "a new session must have a session file in the temporary session directory");
					assert.equal(isInside(sessionFile, sessionDir), true, `the session file must stay in the temporary session directory (${sessionFile})`);
				} finally {
					session.dispose?.();
				}
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
	);

	it(
		"answers the read-only pi-subagents ping/status over the host-owned extension event bus",
		{
			skip: !SMOKE_ENABLED
				? "set PI_GUI_SMOKE=1 to run against the installed Pi SDK"
				: !existsSync(SUBAGENTS_ENTRY)
					? `pi-subagents is not installed at ${SUBAGENTS_ENTRY}; set PI_GUI_SMOKE_SUBAGENTS_PATH to its index.ts`
					: process.env.PI_SUBAGENT_CHILD === "1"
						? "pi-subagents deliberately does not register its parent-side RPC in a child process (PI_SUBAGENT_CHILD=1)"
						: false,
		},
		async () => {
			const loaded = await loadHostSdk({ env: process.env });
			assert.equal(loaded.error, undefined, `the installed SDK must resolve: ${loaded.error ?? ""}`);
			const { sdk } = loaded;

			const tmp = mkdtempSync(join(tmpdir(), "pi-gui-subagents-smoke-"));
			const sessionDir = join(tmp, "sessions");
			const agentDir = process.env.PI_GUI_SMOKE_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
			const channel = openSubagentsChannel({ sdk, cwd: REPO_ROOT, logger: () => {} });
			assert.equal(channel.available, true, `the public channel must open against a real SDK: ${channel.reason ?? ""}`);
			const logs = [];
			let session = null;
			let bridge = null;
			try {
				// Load only pi-subagents: deterministic, and no other user extension runs.
				const resourceLoader = new sdk.DefaultResourceLoader({
					cwd: REPO_ROOT,
					agentDir,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [SUBAGENTS_ENTRY],
					eventBus: channel.eventBus,
				});
				await resourceLoader.reload();
				const extensions = resourceLoader.getExtensions();
				assert.deepEqual(extensions.errors, [], "the real pi-subagents extension must load without errors");
				assert.equal(
					extensions.extensions.some((extension) => String(extension.resolvedPath).includes("pi-subagents")),
					true,
					"pi-subagents must be one of the loaded extensions",
				);

				const sessionManager = sdk.SessionManager.create(REPO_ROOT, sessionDir);
				const created = await sdk.createAgentSession({ cwd: REPO_ROOT, sessionManager, resourceLoader });
				session = created.session;
				const store = new RequestStore();
				const uiContext = createBrowserUIContext({ store, logger: (message) => logs.push(message) });
				await session.bindExtensions({ uiContext, mode: "tui" });
				assert.equal(store.pendingCount, 0, "loading the read-only extension must not raise a browser dialog");

				bridge = new HostSubagentsBridge({ eventBus: channel.eventBus, generation: 1, timeoutMs: 10000 });
				const snapshot = await bridge.bind();
				assert.equal(snapshot.available, true, `the real pi-subagents owner must answer ping/status; logs: ${logs.join(" | ")}`);
				assert.equal(snapshot.error, null);
				assert.equal(["ready-empty", "ready-data"].includes(snapshot.state), true, `unexpected state ${snapshot.state}`);
				assert.equal(Array.isArray(snapshot.fleet.entries), true);
				assert.equal(typeof snapshot.fleet.totalActive, "number");
				assert.equal(Array.isArray(snapshot.asyncSnapshot.runs), true);

				// No real subagent may be started by this smoke test, so the allowlist is empty and a
				// transcript request for any (even a fleet-shaped) key must fail without an RPC.
				const unknown = await bridge.details(1, { generation: 1, id: snapshot.fleet.entries[0]?.key ?? "not-a-run" });
				assert.equal(unknown.ok, false);
				assert.equal(unknown.code, "not_found");
			} finally {
				bridge?.dispose();
				session?.dispose?.();
				rmSync(tmp, { recursive: true, force: true });
			}
		},
	);
});
