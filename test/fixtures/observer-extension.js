/**
 * Test fixture: a third extension that only *observes* Pi's prompt lifecycle events,
 * exactly like a real host/status integration. It never intercepts dialogs itself.
 *
 * - `observer_events` returns the ui_prompt_start/ui_prompt_end events it has seen.
 * - `observer_nest` opens one nested dialog from inside the first `ui_prompt_start`
 *   handler, which is how Pi's coalescing of nested prompts can be observed.
 *
 * Not a test file: it exports an extension factory.
 */

import { Type } from "typebox";

const state = { events: [], nesting: false, nested: 0 };

function result(payload) {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

export default function observerExtension(pi) {
	pi.on("ui_prompt_start", async (event, ctx) => {
		state.events.push({ type: "start", kind: event.kind, title: event.title ?? null, reason: event.reason });
		if (state.nesting && state.nested === 0) {
			state.nested += 1;
			// Nested prompt: raised while the first prompt span is still open.
			const answer = await ctx.ui.confirm("Nested observer prompt", "nested prompt inside the first span");
			state.events.push({ type: "nested-answer", value: answer });
		}
	});

	pi.on("ui_prompt_end", async (event) => {
		state.events.push({ type: "end", kind: event.kind, title: event.title ?? null, reason: event.reason });
	});

	pi.registerTool({
		name: "observer_events",
		label: "Observer events",
		description: "Returns the ui_prompt_* events this observer extension received (test fixture).",
		parameters: Type.Object({}),
		async execute() {
			return result({ events: [...state.events], nesting: state.nesting, nested: state.nested });
		},
	});

	pi.registerTool({
		name: "observer_reset",
		label: "Observer reset",
		description: "Clears recorded lifecycle events (test fixture).",
		parameters: Type.Object({}),
		async execute() {
			state.events.length = 0;
			state.nested = 0;
			return result({ cleared: true });
		},
	});

	pi.registerTool({
		name: "observer_nest",
		label: "Observer nest",
		description: "Enables one nested prompt on the next ui_prompt_start (test fixture).",
		parameters: Type.Object({}),
		async execute() {
			state.nesting = true;
			state.nested = 0;
			return result({ nesting: true });
		},
	});

	pi.registerTool({
		name: "observer_stop_nesting",
		label: "Observer stop nesting",
		description: "Disables nested prompts (test fixture).",
		parameters: Type.Object({}),
		async execute() {
			state.nesting = false;
			return result({ nesting: false });
		},
	});
}
