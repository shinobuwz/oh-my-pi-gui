/**
 * SDK host startup and lifecycle: session creation parameters, `bindExtensions`
 * arguments, URL publication as soon as the bridge listens (before extensions bind, so a
 * session_start dialog can still be answered), fail-closed startup errors, and resource
 * release on shutdown/exit.
 *
 * The SDK is injected (or loaded through `PI_GUI_SDK_PATH` pointing at a fixture module),
 * so no model call, no network and no installed Pi package is involved.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { createHostLifecycle, startHost } from "../src/host/host.js";
import { SDK_PATH_ENV } from "../src/host/sdk-loader.js";
import { createFakeSdk } from "./helpers/fake-sdk.js";
import * as fakeSdkFixture from "./fixtures/fake-sdk.js";

const FAKE_SDK_FIXTURE = resolve(fileURLToPath(new URL("./fixtures/fake-sdk.js", import.meta.url)));

const tempDirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-gui-host-"));
	tempDirs.push(dir);
	return dir;
}

function createLogger() {
	const logs = [];
	return { logs, logger: (message) => logs.push(message) };
}

function createPrinter() {
	const lines = [];
	return { lines, print: (line) => lines.push(line) };
}

const stubFetch = async () => ({ status: 200 });

/**
 * Deterministic read-only Git double. Injecting it also keeps a real `git` child out of the
 * temporary session cwd, whose open handle would otherwise race the temp-directory cleanup on
 * Windows.
 */
function gitStub(branch = "main") {
	return (file, args, options, callback) => {
		queueMicrotask(() => callback(null, `${branch}\n`, ""));
		return { kill: () => {} };
	};
}

after(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("SDK host startup", () => {
	it("creates a new session for the cwd, binds the UI context in rpc mode and publishes the URL file", async () => {
		const tmp = tempDir();
		const cwd = join(tmp, "workspace");
		const urlFile = join(tmp, "state", "url");
		const { sdk, calls, session } = createFakeSdk();
		const { logs, logger } = createLogger();
		const { lines, print } = createPrinter();

		const host = await startHost({ cwd, urlFile, env: {}, sdk, logger, print, fetch: stubFetch, statusExecFile: gitStub() });
		try {
			assert.deepEqual(calls.managers, [{ cwd, sessionDir: undefined, options: undefined }], "the session manager must be created for the requested cwd");
			assert.equal(calls.created.length, 1);
			assert.deepEqual(Object.keys(calls.created[0]).sort(), ["cwd", "sessionManager"], "createAgentSession must only receive cwd and a new session manager");
			assert.equal(calls.created[0].cwd, cwd);
			assert.equal(calls.created[0].sessionManager, host.session.sessionManager);
			assert.equal(calls.bound.length, 1, "bindExtensions must run exactly once");
			assert.deepEqual(Object.keys(calls.bound[0]).sort(), ["mode", "uiContext"]);
			assert.equal(
				calls.bound[0].mode,
				"rpc",
				"rpc keeps the dialog surface and unlocks the pi-subagents host inspect command",
			);
			assert.equal(calls.bound[0].uiContext, host.uiContext);
			for (const member of ["confirm", "select", "input", "editor", "custom"]) {
				assert.equal(typeof calls.bound[0].uiContext[member], "function", `the bound UI context must expose ${member}`);
			}
			// The dialog contract is mode-independent (Pi's hasUI() only depends on a UI context
			// being provided): confirm/select/input/editor still land in the browser under rpc.
			const confirmPromise = calls.bound[0].uiContext.confirm("Mode check", "still answered in the browser?");
			const pending = host.store.snapshot().pending.find((candidate) => candidate.kind === "confirm");
			assert.ok(pending, "rpc mode must still create a browser-answerable confirm request");
			assert.equal(host.store.answer(pending.id, { action: "answer", value: true }).ok, true);
			assert.equal(await confirmPromise, true);
			assert.equal(host.pendingCount, 0, "an answered rpc-mode dialog leaves nothing pending");

			assert.match(host.url, /^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}$/);
			assert.equal(readFileSync(urlFile, "utf8"), `${host.url}\n`);
			assert.match(lines[0], /^Pi GUI host listening: http:\/\/127\.0\.0\.1:\d+\/#t=/, "the URL must be published as soon as the bridge listens");
			assert.match(lines.join("\n"), /^Pi GUI host ready$/m, "the session info is printed after extensions bind");
			assert.match(lines.join("\n"), /new session in Pi's default session directory/);
			assert.match(lines.join("\n"), new RegExp(`URL file: .*${join("state", "url").replace(/\\/g, "\\\\")}`));
			assert.equal(host.pendingCount, 0);
			assert.equal(calls.disposed, 0);
			assert.equal(calls.subscriptions, 2, "the chat and status adapters must subscribe to the session exactly once each");
			assert.equal(host.chat.active, true);
			assert.equal(host.chat.snapshot().available, true);
			assert.equal(host.model.active, true);
			assert.equal(host.model.snapshot().available, true);
			assert.equal(host.status.active, true);
			assert.equal(host.status.snapshot().available, true);
			assert.equal(logs.some((entry) => entry.includes("client self-check passed")), true, "the injected fetch stub must serve the bound-client self-check");
		} finally {
			const closed = await host.close("test");
			assert.deepEqual(closed.errors, []);
		}

		assert.equal(existsSync(urlFile), false, "shutdown must remove the URL file");
		assert.equal(host.bridge.server.listening, false, "shutdown must close the listener");
		assert.equal(calls.disposed, 1, "shutdown must release the session handle");
		assert.equal(calls.unsubscriptions, 2, "shutdown must unsubscribe the chat and status adapters");
		assert.equal(host.chat.active, false, "shutdown must stop the chat adapter");
		assert.equal(host.model.active, false, "shutdown must stop the model adapter");
		assert.equal(host.status.active, false, "shutdown must stop the status adapter");
		assert.equal(host.uiContext.isActive(), false, "shutdown must deactivate the UI context");
		const secondClose = await host.close("test-again");
		assert.deepEqual(secondClose, { cancelled: [], errors: [] });
		assert.equal(calls.disposed, 1, "close must be idempotent");
	});

	it("does not write a URL file when the URL file is disabled but still prints the real URL", async () => {
		const tmp = tempDir();
		const { sdk } = createFakeSdk();
		const { print, lines } = createPrinter();
		const host = await startHost({ cwd: tmp, urlFile: null, env: {}, sdk, print, fetch: stubFetch, statusExecFile: gitStub() });
		try {
			assert.equal(lines[0].includes(host.url), true);
			assert.match(lines.join("\n"), /URL file: \(disabled\)/);
		} finally {
			await host.close("test");
		}
	});

	it("ends pending dialogs with non-approval and never re-approves on shutdown", async () => {
		const tmp = tempDir();
		const { sdk } = createFakeSdk();
		const host = await startHost({ cwd: tmp, urlFile: join(tmp, "url"), env: {}, sdk, fetch: stubFetch, statusExecFile: gitStub() });
		const confirm = host.uiContext.confirm("Pending", "ends without approval");
		const input = host.uiContext.input("Pending input", "placeholder");
		assert.equal(host.pendingCount, 2);
		assert.equal(host.store.snapshot().pending.length, 2);
		const { cancelled, errors } = await host.close("test");
		assert.deepEqual(errors, []);
		assert.deepEqual(cancelled.map((entry) => entry.kind).sort(), ["confirm", "input"]);
		assert.equal(await confirm, false);
		assert.equal(await input, undefined);
		assert.equal(host.pendingCount, 0);
		assert.equal(host.store.answer(cancelled[0].id, { action: "answer", value: true }).ok, false);
	});
});

describe("SDK host fail-closed startup", () => {
	it("reports a bindExtensions failure after publishing, then withdraws the URL", async () => {
		const tmp = tempDir();
		const urlFile = join(tmp, "url");
		const { sdk, calls } = createFakeSdk({ bindError: new Error("bind fixture failure") });
		const { print, lines } = createPrinter();
		await assert.rejects(
			startHost({ cwd: tmp, urlFile, env: {}, sdk, print, fetch: stubFetch, statusExecFile: gitStub() }),
			/bind fixture failure/,
		);
		// The bridge listens before extensions bind, so the URL is published first and then
		// withdrawn by the failed-start cleanup (otherwise a startup dialog could not be answered).
		assert.match(lines[0] ?? "", /^Pi GUI host listening: http:\/\/127\.0\.0\.1:\d+\/#t=/);
		assert.doesNotMatch(lines.join("\n"), /^Pi GUI host ready$/m, "a failed binding must not report a ready host");
		assert.equal(existsSync(urlFile), false, "the failed startup must withdraw the published URL file");
		assert.equal(calls.disposed, 1, "the failed startup must release the session");
		assert.equal(calls.subscriptions, 1, "only the status adapter could subscribe before the chat bound");
		assert.equal(calls.unsubscriptions, 1, "the failed startup must release the status subscription");
	});

	it("reports a createAgentSession failure after publishing, then withdraws the URL", async () => {
		const tmp = tempDir();
		const urlFile = join(tmp, "url");
		const { sdk, calls } = createFakeSdk({ createError: new Error("session fixture failure") });
		const { print, lines } = createPrinter();
		await assert.rejects(startHost({ cwd: tmp, urlFile, env: {}, sdk, print, fetch: stubFetch, statusExecFile: gitStub() }), /session fixture failure/);
		assert.match(lines[0] ?? "", /^Pi GUI host listening: http:\/\/127\.0\.0\.1:\d+\/#t=/);
		assert.doesNotMatch(lines.join("\n"), /^Pi GUI host ready$/m);
		assert.equal(existsSync(urlFile), false);
		assert.equal(calls.disposed, 0, "no session was created, so there is nothing to release");
	});

	it("refuses an injected SDK with an unknown export shape before creating a session", async () => {
		const tmp = tempDir();
		const urlFile = join(tmp, "url");
		let createCalls = 0;
		const { print, lines } = createPrinter();
		await assert.rejects(
			startHost({
				cwd: tmp,
				urlFile,
				env: {},
				sdk: { createAgentSession: () => { createCalls += 1; return Promise.resolve({ session: {} }); } },
				print,
				fetch: stubFetch,
			}),
			/missing SessionManager\.create/,
		);
		assert.equal(createCalls, 0);
		assert.equal(lines.length, 0);
		assert.equal(existsSync(urlFile), false);
	});

	it("reports a bridge bind failure, publishes nothing and never creates a session", async () => {
		const tmp = tempDir();
		const urlFile = join(tmp, "url");
		const { sdk, calls } = createFakeSdk();
		const { print, lines } = createPrinter();
		const bindError = Object.assign(new Error("bind fixture failure"), { code: "EADDRINUSE" });
		await assert.rejects(
			startHost({
				cwd: tmp,
				urlFile,
				env: {},
				sdk,
				print,
				fetch: stubFetch,
				listen: () => {
					throw bindError;
				},
			}),
			/EADDRINUSE/,
		);
		assert.equal(lines.length, 0, "a bridge that never bound must not print a URL");
		assert.equal(existsSync(urlFile), false);
		assert.equal(calls.disposed, 0, "the session is created only after the bridge listens");
		assert.equal(calls.created.length, 0, "a failed bridge must not create a session");
	});

	it("reports SDK resolution failure with the attempts and publishes nothing", async () => {
		const tmp = tempDir();
		const { print, lines } = createPrinter();
		await assert.rejects(
			startHost({
				cwd: tmp,
				urlFile: join(tmp, "url"),
				env: { [SDK_PATH_ENV]: join(tmp, "missing-sdk") },
				print,
				fetch: stubFetch,
			}),
			/refusing to fall back/,
		);
		assert.equal(lines.length, 0);
		assert.equal(existsSync(join(tmp, "url")), false);
	});

	it("refuses a session without the public chat members before binding extensions", async () => {
		const tmp = tempDir();
		const urlFile = join(tmp, "url");
		let bound = 0;
		let disposed = 0;
		const session = {
			sessionManager: { getSessionFile: () => null },
			isIdle: true,
			isStreaming: false,
			bindExtensions() {
				bound += 1;
				return Promise.resolve();
			},
			dispose() {
				disposed += 1;
			},
		};
		const sdk = {
			SessionManager: { create: () => session.sessionManager },
			createAgentSession: async () => ({ session }),
		};
		const { print, lines } = createPrinter();
		await assert.rejects(
			startHost({ cwd: tmp, urlFile, env: {}, sdk, print, fetch: stubFetch }),
			/without the public members the browser chat requires: prompt, abort, subscribe/,
			"a changed SDK session shape must be refused with the missing members",
		);
		assert.equal(bound, 0, "a session without the chat members must not be bound");
		assert.equal(disposed, 1, "the refused session must still be released");
		assert.match(lines[0] ?? "", /^Pi GUI host listening: /);
		assert.doesNotMatch(lines.join("\n"), /^Pi GUI host ready$/m, "a refused session shape must not report a ready host");
		assert.equal(existsSync(urlFile), false, "the failed startup must withdraw the published URL file");
	});

	it("refuses a session without the public model actions before binding extensions", async () => {
		const tmp = tempDir();
		const urlFile = join(tmp, "url");
		let bound = 0;
		let disposed = 0;
		const session = {
			sessionManager: { getSessionFile: () => null, buildContextEntries: () => [] },
			isIdle: true,
			isStreaming: false,
			prompt: () => Promise.resolve(),
			abort: () => Promise.resolve(),
			subscribe: () => () => {},
			setModel: async () => true,
			bindExtensions() {
				bound += 1;
				return Promise.resolve();
			},
			dispose() {
				disposed += 1;
			},
		};
		const sdk = {
			SessionManager: { create: () => session.sessionManager },
			createAgentSession: async () => ({ session }),
		};
		const { print, lines } = createPrinter();
		await assert.rejects(
			startHost({ cwd: tmp, urlFile, env: {}, sdk, print, fetch: stubFetch }),
			/without the public actions the browser model controls require: setThinkingLevel/,
			"a session that cannot change the model/thinking level must fail closed",
		);
		assert.equal(bound, 0, "a session without the model actions must not be bound");
		assert.equal(disposed, 1, "the refused session must still be released");
		assert.match(lines[0] ?? "", /^Pi GUI host listening: /);
		assert.doesNotMatch(lines.join("\n"), /^Pi GUI host ready$/m);
		assert.equal(existsSync(urlFile), false);
	});

	it("keeps chat and control routes detached until their session adapters are attached", async () => {
		const lifecycle = createHostLifecycle();
		assert.equal(lifecycle.sessionSnapshot({ chatSince: 3 }), null, "no section before a session adapter exists");
		assert.deepEqual(await lifecycle.sessionMessage(1, { generation: 1, text: "hi" }), {
			ok: false,
			status: 503,
			code: "not_attached",
			message: "the browser chat is not attached to a session",
		});
		assert.equal((await lifecycle.sessionStop(1, { generation: 1 })).code, "not_attached");
		const detachedModel = await lifecycle.sessionModel(1, { generation: 1, key: "fixture/model-a" });
		assert.deepEqual(detachedModel, {
			ok: false,
			status: 503,
			code: "not_attached",
			message: "the browser model controls are not attached to a session",
		});
		const detachedThinking = await lifecycle.sessionThinking(1, { generation: 1, level: "low" });
		assert.equal(detachedThinking.code, "not_attached");
		assert.equal(detachedThinking.message, "the browser thinking controls are not attached to a session");

		const adapter = {
			snapshot: (options) => ({ available: true, since: options.since }),
			sendMessage: async () => ({ ok: true, delivery: "normal" }),
			stop: async () => ({ ok: true, requested: true }),
		};
		assert.equal(lifecycle.attachChat(adapter), adapter);
		assert.deepEqual(lifecycle.sessionSnapshot({ chatSince: 3 }), { chat: { available: true, since: 3 } }, "the chat section is nested for /api/state");
		assert.deepEqual(await lifecycle.sessionMessage(1, { generation: 1, text: "hi" }), { ok: true, delivery: "normal" });

		const model = {
			snapshot: () => ({ available: true, model: { provider: "fixture", id: "model-a" }, candidates: [] }),
			selectModel: async (generation, body) => ({ ok: true, generation, key: body.key }),
			setThinkingLevel: async (generation, body) => ({ ok: true, generation, level: body.level }),
		};
		const status = { snapshot: () => ({ available: true, cwd: "E:/workspace" }) };
		assert.equal(lifecycle.attachModel(model), model);
		assert.equal(lifecycle.attachStatus(status), status);
		assert.deepEqual(lifecycle.sessionSnapshot({ chatSince: 3 }), {
			chat: { available: true, since: 3 },
			controls: { available: true, model: { provider: "fixture", id: "model-a" }, candidates: [] },
			status: { available: true, cwd: "E:/workspace" },
		}, "the control and status sections are nested for /api/state");
		assert.deepEqual(await lifecycle.sessionModel(1, { generation: 1, key: "fixture/model-a" }), { ok: true, generation: 1, key: "fixture/model-a" });
		assert.deepEqual(await lifecycle.sessionThinking(1, { generation: 1, level: "low" }), { ok: true, generation: 1, level: "low" });

		assert.equal(lifecycle.detachChat(), adapter);
		assert.equal(lifecycle.detachModel(), model);
		assert.equal(lifecycle.detachStatus(), status);
		assert.equal(lifecycle.sessionSnapshot(), null);
		assert.equal((await lifecycle.sessionModel(1, { generation: 1, key: "fixture/model-a" })).code, "not_attached");
	});
});

describe("SDK host exit cleanup", () => {
	it("removes the URL file and ends pending dialogs synchronously", async () => {
		const tmp = tempDir();
		const urlFile = join(tmp, "url");
		const { sdk } = createFakeSdk();
		const host = await startHost({ cwd: tmp, urlFile, env: {}, sdk, fetch: stubFetch, statusExecFile: gitStub() });
		const editor = host.uiContext.editor("Pending editor", "draft");
		assert.equal(existsSync(urlFile), true);
		host.exitCleanup();
		assert.equal(existsSync(urlFile), false);
		assert.equal(host.pendingCount, 0);
		assert.equal(host.uiContext.isActive(), false);
		assert.equal(await editor, undefined);
		const closed = await host.close("after-exit");
		assert.deepEqual(closed.errors, []);
		assert.equal(existsSync(urlFile), false);
	});
});

describe("SDK host loader seam", () => {
	it("starts from the module named by PI_GUI_SDK_PATH when no SDK is injected", async () => {
		const state = fakeSdkFixture.state;
		state.calls.managers.length = 0;
		state.calls.created.length = 0;
		state.calls.bound.length = 0;
		state.calls.disposed = 0;
		const tmp = tempDir();
		const urlFile = join(tmp, "url");
		const { print, lines } = createPrinter();
		const host = await startHost({
			cwd: tmp,
			urlFile,
			env: { [SDK_PATH_ENV]: FAKE_SDK_FIXTURE },
			print,
			fetch: stubFetch,
			statusExecFile: gitStub(),
		});
		try {
			assert.equal(host.sdk.entryPath, FAKE_SDK_FIXTURE);
			assert.equal(host.sdk.source, `env:${SDK_PATH_ENV}`);
			assert.equal(state.calls.managers.length, 1);
			assert.equal(state.calls.managers[0].cwd, tmp);
			assert.equal(state.calls.created.length, 1);
			assert.equal(state.calls.bound.length, 1);
			assert.equal(state.calls.bound[0].mode, "rpc");
			assert.equal(readFileSync(urlFile, "utf8"), `${host.url}\n`);
			assert.equal(lines[0].includes(host.url), true);
		} finally {
			await host.close("test");
		}
		assert.equal(state.calls.disposed, 1);
	});
});
