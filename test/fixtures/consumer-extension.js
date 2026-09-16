/**
 * Test fixture: a second extension that consumes the standard Pi dialogs through
 * `ctx.ui` exactly like a real extension does. It is loaded by the real Pi extension
 * loader in `test/runner-binding.test.js`, so the browser adapter has to work through
 * the host's shared UI context rather than a test-local helper.
 *
 * Not a test file: it exports an extension factory.
 */

import { Type } from "typebox";

function result(payload) {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

export default function consumerExtension(pi) {
	pi.registerTool({
		name: "consumer_probe",
		label: "Consumer probe",
		description: "Runs confirm/select/input/editor/custom through ctx.ui (test fixture).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const calls = [];
			const confirmValue = await ctx.ui.confirm("Probe confirm", "Confirm from the browser?");
			calls.push({ kind: "confirm", value: confirmValue, valueType: typeof confirmValue });
			const selectValue = await ctx.ui.select("Probe select", ["Red", "Blue", "Green"]);
			calls.push({ kind: "select", value: selectValue, valueType: typeof selectValue });
			const inputValue = await ctx.ui.input("Probe input", "type here");
			calls.push({ kind: "input", value: inputValue, valueType: typeof inputValue });
			const editorValue = await ctx.ui.editor("Probe editor", "prefilled line");
			calls.push({ kind: "editor", value: editorValue, valueType: typeof editorValue });
			let customError = null;
			try {
				await ctx.ui.custom(() => ({ render: () => [], handleInput: () => {}, invalidate: () => {} }));
				customError = null;
			} catch (error) {
				customError = error instanceof Error ? error.message : String(error);
			}
			calls.push({ kind: "custom", value: null, valueType: "undefined", error: customError });
			return result({ calls, customError });
		},
	});

	pi.registerTool({
		name: "consumer_probe_timeout",
		label: "Consumer probe timeout",
		description: "confirm() with a host timeout (test fixture).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const value = await ctx.ui.confirm("Probe timeout", "This prompt expires", { timeout: 400 });
			return result({ kind: "confirm", value, valueType: typeof value });
		},
	});

	pi.registerTool({
		name: "consumer_probe_abort",
		label: "Consumer probe abort",
		description: "confirm() with an AbortSignal (test fixture).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 200);
			try {
				const value = await ctx.ui.confirm("Probe abort", "This prompt is aborted", { signal: controller.signal });
				return result({ kind: "confirm", value, valueType: typeof value, aborted: controller.signal.aborted });
			} finally {
				clearTimeout(timer);
			}
		},
	});

	pi.registerTool({
		name: "consumer_probe_select",
		label: "Consumer probe select",
		description: "select() only, for duplicate/answer validation tests (test fixture).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const value = await ctx.ui.select("Probe select only", ["Alpha", "Beta"]);
			return result({ kind: "select", value, valueType: typeof value });
		},
	});
}
