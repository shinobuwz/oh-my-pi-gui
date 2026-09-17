/**
 * Build the browser UI once, on first launch.
 *
 * Later `npm start` reuses dist/browser. After editing src/browser, run
 * `npm run build:ui` (or delete dist/browser) to rebuild.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILT_ASSETS_DIR } from "./host.js";

const CONFIG_FILE = fileURLToPath(new URL("../../vite.config.js", import.meta.url));

async function defaultBuild() {
	const { build } = await import("vite");
	await build({ configFile: CONFIG_FILE, logLevel: "error" });
}

/**
 * @param {object} [options]
 * @param {string} [options.builtDir]
 * @param {(path: string) => boolean} [options.exists]
 * @param {() => Promise<unknown>} [options.buildUi]
 * @param {(message: string) => void} [options.logger]
 * @returns {Promise<{ built: boolean }>}
 */
export async function ensureBrowserUi({
	builtDir = BUILT_ASSETS_DIR,
	exists = existsSync,
	buildUi = defaultBuild,
	logger = () => {},
} = {}) {
	if (exists(join(builtDir, "index.html"))) {
		return { built: false };
	}
	logger("building browser UI (first run)…");
	await buildUi();
	logger("browser UI ready");
	return { built: true };
}
