import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ensureBrowserUi } from "../src/host/ensure-ui-build.js";

describe("ensureBrowserUi", () => {
	it("skips Vite when dist/browser/index.html already exists", async () => {
		const calls = [];
		const result = await ensureBrowserUi({
			builtDir: "/tmp/pi-gui-ui",
			exists: (path) => path.replaceAll("\\", "/").endsWith("/index.html"),
			buildUi: async () => {
				calls.push("build");
			},
		});
		assert.deepEqual(result, { built: false });
		assert.deepEqual(calls, []);
	});

	it("builds once when the UI output is missing", async () => {
		const logs = [];
		const result = await ensureBrowserUi({
			builtDir: "/tmp/pi-gui-ui-missing",
			exists: () => false,
			buildUi: async () => {
				logs.push("build");
			},
			logger: (message) => logs.push(message),
		});
		assert.deepEqual(result, { built: true });
		assert.deepEqual(logs, ["building browser UI (first run)…", "build", "browser UI ready"]);
	});
});
