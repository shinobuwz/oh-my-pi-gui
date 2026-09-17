/**
 * Assistant-markdown island: mounts dsh MarkdownText onto a stable DOM node.
 * The page controller (app.js) owns lifecycle; this module only renders GFM + TeX.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import "katex/dist/katex.min.css";

/** Reference-stable labels: a new object identity would drop the streaming cache. */
const LABELS = Object.freeze({
	code: Object.freeze({
		copyLabel: "Copy",
		copiedLabel: "Copied",
	}),
	footnotes: "Footnotes",
});

const roots = new WeakMap();

export function mountMarkdown(element, { text = "", streaming = false } = {}) {
	if (!element) {
		return;
	}
	let root = roots.get(element);
	if (!root) {
		root = createRoot(element);
		roots.set(element, root);
	}
	root.render(createElement(MarkdownText, { text, streaming, labels: LABELS }));
}

export function unmountMarkdown(element) {
	const root = roots.get(element);
	if (!root) {
		return;
	}
	root.unmount();
	roots.delete(element);
}
