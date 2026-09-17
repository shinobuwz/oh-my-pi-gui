import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const browserRoot = fileURLToPath(new URL("./src/browser", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/browser", import.meta.url));

export default defineConfig({
	root: browserRoot,
	base: "/",
	plugins: [react()],
	build: {
		outDir,
		emptyOutDir: true,
		sourcemap: false,
		assetsInlineLimit: 0,
		cssMinify: true,
	},
});
