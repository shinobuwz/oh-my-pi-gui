/**
 * Test fixture: an extension that immediately exercises the UI context supplied by the
 * host. It is loaded by the real Pi resource loader in `test/sdk-smoke.test.js`, so a
 * successful `bindExtensions({ uiContext, mode: "rpc" })` must be observable in our UI
 * context without any model call.
 *
 * Not a test file: it exports an extension factory.
 */

export default function uiProbeExtension(pi) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("ui-probe", "session_start");
		ctx.ui.notify("ui-probe bound to the browser UI context", "info");
	});
}
