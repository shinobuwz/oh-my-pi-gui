# oh-my-pi-gui — browser interaction bridge (Pi 0.85.1, browser-only lifecycle)

This repository currently implements the **interaction, lifecycle, chat, main-session
model/thinking control, compact session-status and read-only pi-subagents status slices** of
the Pi web GUI from `openspec/changes/browser-interaction-spike`: standard extension
dialogs (**confirm, select, input, editor**), the **session reload**, and a browser
multiline chat composer that streams the current session's assistant output. Pi's own
prompt lifecycle notifications and active-branch session history remain in use.

The subagent slice is read-only: fleet display keys and async run ids are kept as
separate public identities, with explicit status refresh and on-demand transcript tails.
It does not expose mutations, spawning, scheduler/configuration, filesystem or artifact
access.

What is implemented:

- a minimal Pi extension that rebinds the live `ExtensionRunner` to a **bridge UI
  context**, so the host's own `withUIPrompt` wrapper keeps emitting
  `ui_prompt_start` / `ui_prompt_end` (including concurrent and nested coalescing) while
  the dialog itself is answered in the browser;
- a loopback HTTP bridge with a per-process bearer token, exact Host/Origin checks,
  request size limits, value validation and a vanilla local page (no CDN, no build step);
  ephemeral binding skips the undici (Node fetch) bad-port set plus Chromium
  `ERR_UNSAFE_PORT` extras, then performs a bound-client self-check with a hard 1.5 s timeout
  before publishing the URL; the self-check never follows redirects off loopback, and a
  client that never settles is recorded as inconclusive instead of blocking startup;
  ten rejected attempts fail closed and publish no URL; ordinary network-check failures and
  self-check timeouts are recorded diagnostically without discarding a listener that is
  already bound;
- a browser chat path that sends multiline text through `pi.sendUserMessage()` with
  prompt-template expansion, lets the user choose **Normal**, **Steer**, or **Follow-up**,
  shows incremental assistant text plus bounded thinking/tool-call/tool-result blocks,
  folds thinking and long tool output with native disclosures, reconciles the current
  active branch on reconnect/finalization without duplicate rows, and routes Stop to the
  current `ctx.abort()`; busy normal sends and unsupported slash commands are rejected
  explicitly, while busy steer/follow-up requests report acceptance and queueing without
  claiming that execution has completed (extension-source slash commands are identified as
  immediate by the host contract instead of being reported as queued);
- a generation-scoped **Current model and thinking** panel. Model candidates come only from
  `ctx.scopedModels`, or from `ctx.modelRegistry.getAvailable()` when the scope is empty;
  the browser sends an exact candidate key rather than a model object. Model metadata is
  allowlisted to provider/id/name and useful capability fields, never credentials or provider
  configuration. Model selection reports authentication failure without changing the current
  model, while thinking choices are limited to Pi's seven levels and report the host's
  effective (possibly clamped) level. These changes are session-only and do not write defaults;
- a generation-scoped **Session status** panel. It displays the bounded `ctx.cwd`, an
  asynchronously refreshed Git branch (including an unborn symbolic branch or a detached
  short label), finite session token totals for input/output/cache reads/cache writes/total,
  and the public context tokens/window/percent values. Missing or invalid values remain
  explicitly unknown; no prompt content, cost or provider configuration is exposed;
- a generation-scoped, read-only **Subagents** panel. It projects the public pi-subagents
  fleet entries and separate async snapshot runs, preserves omitted/truncated indicators,
  distinguishes RPC unavailable/timeout/error/empty states, subscribes only to the public
  ready/async-started/async-complete/child-status hints for status refresh, keeps a manual
  Refresh button, and requests a bounded transcript tail only for a current-generation
  async run id;
- browser-initiated **reload of the current session**: pending prompts end with their
  non-approval result, the page keeps the same URL and token, reconnects to the new
  binding generation automatically and old-generation answers are refused;
- disconnect/reconnect replay of pending request ids, explicit cancellation, consumer
  `timeout`/`AbortSignal` semantics, duplicate/late reply rejection, and resource
  cleanup that never approves anything.

What is explicitly **not** covered (and must not be reported as MVP success):

- **Custom terminal component prompts (`ctx.ui.custom`) are unsupported by design** (see
  [Questionnaire and custom components](#questionnaire-and-custom-components)). The user
  accepted deferring the questionnaire; ordinary text questions can use the minimal chat
  path, but structured questionnaire answers are not adapted here.
- No subagent mutations, spawning, scheduler/configuration controls, or filesystem/artifact
  access. The read-only projection subscribes only to public ready, async-started,
  async-complete and child-status hints for status refresh; transcript detail is a bounded
  status response, not a markdown renderer or a completion claim.
- Pi's built-in pickers and other extensions' custom components are not adapted.
- Only Pi **0.85.1** is supported; any other host version makes the bridge refuse to
  enable instead of silently falling back to terminal dialogs.

## Requirements

- Node.js 24.x (verified with v24.16.0) and npm 11.x
- An installed Pi **0.85.1** (`@earendil-works/pi-coding-agent`); the prototype is
  version-locked and verifies the host it runs inside
- No dependency installation is required for the prototype or its tests

Runner capture prioritizes resolving `ExtensionRunner` from the running host package's absolute
path; when the package root is unavailable, the bare specifier is only a last fallback. If
that capture cannot be established, the GUI reports the reason and explicitly refuses to
enable instead of falling back to terminal prompts.

## Running it against a live Pi session

The terminal is only needed once, to start Pi with the extension loaded:

```bash
cd oh-my-pi-gui
pi -e ./extensions/browser-interaction/index.js
```

At `session_start` the extension starts the bridge and prints, in the transcript:

```
Browser UI ready: http://127.0.0.1:<port>/#t=<token>
```

Open that URL once in a local browser. From then on, every standard dialog
(`confirm`/`select`/`input`/`editor`) raised by any extension in that session appears in
the browser and is answered there; the terminal shows no dialog and is never used as a
fallback while the bridge is running.

The browser page also drives the session: the **Reload Pi session** button reloads
extensions inside the same Pi process, keeping the same URL and token.

Terminal commands are only needed for the first start or for diagnostics, never for
answering prompts or reloading once the page is open:

| Command | Effect |
| --- | --- |
| `/browser-ui status` | bridge state, generation, Pi version, `ctx.ui` binding check, Runner capture source/candidate URL/attempts, pending prompts, recent log |
| `/browser-ui reload` | reloads the session from the terminal (same flow as the browser button) |
| `/browser-ui url` | prints the current URL (contains the token) again |
| `/browser-ui stop` | stops the bridge, ends pending prompts without approval, restores the host dialogs |
| `/browser-ui start` | starts the bridge again (also used when `PI_BROWSER_UI_AUTOSTART=0`) |

The URL is also written to `.browser-ui/url` (gitignored, mode 0600 where supported) so it
can be read from another terminal: `cat .browser-ui/url`. The file is removed on shutdown.

Environment variables:

| Variable | Meaning |
| --- | --- |
| `PI_BROWSER_UI_AUTOSTART=0` | do not start the bridge automatically; use `/browser-ui start` |
| `PI_BROWSER_UI_PACKAGE_ROOT=<dir>` | where the running Pi package root is, for non-standard installations (still version- and structure-checked) |
| `PI_BROWSER_UI_URL_FILE=<path>` | write the URL file somewhere else (used by tests) |
| `PI_BROWSER_UI_RELOAD_IDLE_MS=<ms>` | how long a browser reload waits for the session to become idle (default 20000) |
| `PI_BROWSER_UI_RELOAD_TIMEOUT_MS=<ms>` | upper bound while browser reload waits for the host to complete its reload (default 45000); timeout releases the reload lock and returns `504 reload_timeout` |

## Browser behaviour

- The token is read from the URL fragment (`#t=…`) and kept in `sessionStorage`; the
  fragment is removed from the visible URL. It is sent only as an `Authorization: Bearer`
  header to the loopback API.
- Each pending prompt shows the original title, message, options or prefill. **Nothing is
  submitted without an explicit click** (Yes/No, option + submit, text + submit, or
  `Cancel without answering`); there is no default answer and no auto-confirmation.
- Buttons disable while a reply is in flight; rejected replies are shown with their error
  code and the prompt stays pending.
- The Chat panel accepts multiline text only on explicit Send. The Delivery selector
  offers **Normal** (idle-only), **Steer** (queued during a response), and **Follow-up**
  (queued until the response finishes). The bridge passes busy selections through Pi's
  public `sendUserMessage()` API with the exact `deliverAs` value and prompt-template
  expansion; idle steer/follow-up selections are reported as immediate normal delivery.
  Assistant text, thinking, tool calls and tool results arrive as bounded text-safe blocks;
  thinking and long tool output are collapsed by default. Rows update in place and keep
  the browser's reading position. Stop calls the current generation's `ctx.abort()`.
- `/api/state` accepts an optional `since=<chat revision>` query parameter. Without a valid
  1–12 digit value it keeps the complete-snapshot behaviour for older clients. A valid
  revision behind the current chat returns `messagesFull: false`, only messages whose
  per-message `revision` changed, and the complete ordered `historyIds` list; an equal
  revision returns no messages and `historyIds: null`; an invalid or future revision returns
  `messagesFull: true` with all messages and ids. The page sends `since` after it learns a
  revision, merges the delta into its id/order cache, removes ids no longer in `historyIds`,
  and rebuilds a chat row's blocks only when that row's message revision changes, including
  the currently streaming row. This reduces the browser payload and DOM reconstruction, but
  the host still computes content keys across the full bounded history on every snapshot
  (at the upper bound, on the order of tens of milliseconds per round); state polling is
  not thereby made cheap.
- The read-only Session status panel shows cwd, Git branch, session token totals and context
  usage. Git refreshes are asynchronous and bounded; non-repository, unavailable or failing
  Git is shown as Unknown rather than exposing command errors.
- The Current model and thinking panel uses explicit **Use model** and **Use thinking level**
  submissions. It displays the host's effective state after each request, including a
  `setModel()` authentication failure or thinking-level clamp, and says that the current turn
  has not been claimed complete.
- The Subagents panel keeps opaque fleet display keys separate from real async run ids.
  Refresh is manual; **View transcript** is on-demand and sends only the current generation,
  run id, `view: "transcript"` and the fixed server-side line limit. Unavailable, timeout,
  failed-reply and empty/omitted status remain visibly distinct.
- Busy normal sends, unsupported delivery modes and unknown slash commands are rejected
  visibly; queued steer/follow-up responses say they were accepted/queued, not executed,
  while streaming extension-source slash commands are identified as immediate and not part
  of that queue. When the host runner exposes its public error stream, accepted delivery
  failures are shown after the fact; otherwise the status reports **delivery failure
  visibility unavailable** and such failures may not be visible.
- If the page loses the connection it reports `Disconnected…` and keeps retrying; pending
  prompts stay on the host, and they reappear with the same request ids on reconnect.
- If the Pi process restarts, the bridge gets a **new token** and the old page shows
  "Not authorized — the Pi session likely restarted." A same-process session reload keeps
  the URL/token and instead changes the browser generation; the page reconnects to it.

## Reload and reconnect continuity

- The listening server, access token, pending-request store and generation counter are
  **process-owned** (`src/core/bridge-registry.js`), not per extension instance.
  Reloading extensions therefore adopts the same port and token: the page reconnects by
  itself, with no new URL, no token re-entry and no terminal step.
- Every binding gets a new **generation**. A reload ends pending prompts with their
  non-approval result first, waits (bounded) for the session to become idle and then runs
  Pi's own reload entry point through the host command context. While a reload is in
  flight the API rejects answers with `409 reloading`; answers targeting an old generation
  are rejected as stale, and stale UI contexts throw instead of silently producing a
  terminal prompt.
- A busy or refused reload (for example while streaming or compacting) reports `busy`
  or `reload_refused` to the page, leaves the bridge usable and creates no new generation.
  If the host reload promise exceeds `PI_BROWSER_UI_RELOAD_TIMEOUT_MS`, the bridge releases
  the lock and reports `504 reload_timeout`; the host may still finish in the background, so
  wait for the page to reconnect and confirm the new generation before retrying reload. Do
  not treat the request as confirmed success.
- If the old binding was detached but the replacement instance could not attach, the page
  receives `503 attach_failed` with the recorded reason; this means the environment changed
  and the old browser handler is gone, not that nothing changed.
- `session_shutdown` for a real **quit** closes the port and clears the token, the store
  and the URL file. Session replacement (`/new`, `/resume`, `/fork`) keeps the browser
  entry point and bumps the generation, like reload.
- Closing the browser page never ends the Pi session.

## Security model

- The server binds `127.0.0.1` on an ephemeral port only.
- Every request must carry `Host: 127.0.0.1:<port>`; API reads require the bearer token.
- Writes additionally require `Origin: http://127.0.0.1:<port>` (and reject cross-site
  `Sec-Fetch-Site`), so another page in the browser cannot drive the session.
- Bodies are limited to 320 KiB so a 64 Ki character message/editor value remains within
  the limit even at 4-byte UTF-8 plus JSON wrapper overhead; `confirm` answers must be booleans, `select` answers must
  match the offered options, `input`/`editor` answers are length-limited, and chat text is
  bounded before it reaches `pi.sendUserMessage()`.
- Replies are accepted once per request id; duplicates, late replies, unknown ids and
  type mismatches are rejected and never reach the host flow.
- The page is served from three allow-listed local files (`index.html`, `app.js`,
  `app.css`); there is no path input, no directory listing and no file read/write API.
- Everything from the host is rendered with `textContent` (no `innerHTML`), and the
  response CSP is `default-src 'none'` with same-origin script/style/connect only.
- Subagent routes require the bearer token, exact loopback Origin and exact generation-bound
  body fields. Fleet keys cannot target transcript requests; only async ids retained by the
  current status cache can do so. DTOs are bounded and best-effort redacted; child-task
  transcript text is real child output and may contain host paths or sensitive text. The
  page boundary remains loopback-only and bearer-token protected, with no raw task fields,
  artifact access or mutation methods exposed as controls.
- The page never approves on timeout or disconnect; non-approval results are `false`
  (`confirm`) or `undefined` (`select`/`input`/`editor`), matching the host contract.

## Lifecycle

| Event | Behaviour |
| --- | --- |
| browser disconnect | pending prompts stay on the host; nothing is approved, nothing is sent to the terminal |
| explicit cancel in the browser | the caller receives the non-approval value |
| consumer `timeout` option | the caller receives the non-approval value; late browser replies are rejected |
| consumer `AbortSignal` | same as timeout |
| browser "Reload Pi session" / `/browser-ui reload` | pending prompts end without approval, the session is awaited to idle, Pi's reload runs, the same URL/token serves the new generation |
| `/new`, `/resume`, `/fork` | same continuity as reload: same browser entry point, new generation, old ids refused |
| real quit (`session_shutdown: quit`) | pending prompts end without approval, port closed, token/store/URL file cleared |
| stale `ctx.ui` reference after reload/shutdown | calls fail with an explicit error instead of answering or falling back to the terminal |

## Questionnaire and custom components

The user accepted deferring the questionnaire in the first version; a structured form is
**not** implemented, and that is a scope decision, not a pending bug fix.

`ctx.ui.custom(factory)` hands over a terminal component whose closure owns its own data
(questions, options, answers), so the browser cannot read or answer it within the approved
private-UI boundary. What happens instead:

- the browser shows an explicit *unsupported interaction* notice;
- the original call fails immediately with an explicit error — it does not hang, does not
  fall back to the terminal and never produces an invented or auto-confirmed answer;
- standard `confirm`/`select`/`input`/`editor` dialogs keep working from the browser, and
  Pi's prompt lifecycle notifications still fire for the unsupported interaction;
- ordinary questions are expected to be asked in chat once that work group lands; plain
  chat text is not, and will not be presented as, a structured questionnaire result.

`test/questionnaire-diagnostic.test.js` reproduces this against a read-only copy of the
installed questionnaire.

## Automated verification

```bash
npm test                      # full suite (node --test)
npm run check                 # syntax check of every source and page file
npm run test:host             # real Pi loader + ExtensionRunner binding tests
```

Host tests locate the installed Pi package automatically (`PI_BROWSER_UI_PACKAGE_ROOT`
overrides it) and **fail loudly** if it cannot be found. Set
`PI_BROWSER_UI_SKIP_CLI_TEST=1` to skip the real-CLI load check.

Test inventory and the real-vs-stub boundary:

| Test file | Covers | Boundary |
| --- | --- | --- |
| `test/request-store.test.js` | pending lifetime, explicit answers, non-approval exits, duplicate/late rejection, limits | pure host-store unit tests |
| `test/bridge-server.test.js` | undici/Chromium bad-port boundaries (full reference port table compared item by item, undici entries re-verified against the running Node client), bound-client self-check, bounded never-settling self-check timeout with redirect: "manual", client-rejected rebind including a code-only `ERR_UNSAFE_PORT`, ordinary network-error diagnostics, self-check token redaction in diagnostics/logs/thrown errors and ten-attempt fail-closed behavior, token/Host/Origin/size/content-type/method checks, asset allow-list, reconnect replay, prompt text kept as data | real HTTP plus injected bind and fetch seams |
| `test/browser-bridge.test.js` | adapter seam: the injected fetch reaches the bound-client self-check, `info().bindingDiagnostics` exposes outcome/attempts and the shared bridge log records the self-check | real adapter against a fake host package and a fake `withUIPrompt`-shaped runner |
| `test/browser-assets.test.js` | no dynamic HTML sinks, no external origins, fragment token + Authorization header, submit only on user action | static guards on the served page |
| `test/browser-page.test.js` | the served page logic runs against a strict fake DOM: token handling, delivery selection and accepted-vs-executed wording, thinking/tool folding, chat rendering/stream reconciliation, multiline submission, Stop, prompt cards for every kind, explicit submissions, cancel/dismiss, rejection feedback, 401 handling | fake DOM (a real browser is still required for final acceptance; `innerHTML` throws in the fake DOM) |
| `test/chat-bridge.test.js` | generation-scoped chat submission, idle/busy delivery mapping and exact public options, command/delivery rejection, bounded structured blocks, tool execution updates and active-branch reconciliation, Stop/abort and stale controls | public-API-shaped unit fixtures |
| `test/chat-server.test.js` | authenticated generation-bound chat state/message/Stop routes and cross-site/stale rejection | real HTTP against the real server with a session-control fixture |
| `test/model-bridge.test.js` | scoped/non-scoped candidate allowlists, stable deduplication, safe snapshots, auth failure, effective model/thinking events, clamping and disposal | public-API-shaped model fixtures |
| `test/model-server.test.js` | authenticated model/thinking routes, exact candidate-key forwarding, generation and Origin rejection | real HTTP against the real server |
| `test/model-page.test.js` | candidate selectors, explicit submissions, effective-state and rejection feedback | strict fake DOM |
| `test/status-bridge.test.js` | active-branch usage aggregation, context null/known values, bounded cwd, injected Git normal/unborn/detached/non-repository handling, event refresh and generation disposal | public-API-shaped unit fixtures |
| `test/subagents-bridge.test.js` | correlated public ping/status RPC, generation-scoped fleet/async projection, identity separation, fixed transcript params, timeout/error distinction and redaction | public event-bus fixture |
| `test/subagents-server.test.js` | authenticated read-only details/refresh routes, exact body fields, generation and Origin rejection | real HTTP against the real server with a session-control fixture |
| `test/subagents-page.test.js` | bounded fleet/async rendering, manual transcript detail, text-only output and visibly distinct timeout/omitted states | strict fake DOM |
| `test/runner-binding.test.js` | installed Pi loader + `ExtensionRunner` + separate consumer **and lifecycle observer** extensions answering confirm/select/input/editor over HTTP; host-emitted `ui_prompt_start`/`ui_prompt_end` (single, concurrent-coalesced, nested); reconnect, duplicate, invalid, timeout, abort, cancel; custom-unsupported; browser-initiated reload with a pending dialog; reload window rejection; bounded busy/idle refusal; session replacement; quit cleanup; two status diagnostics for installed-but-unbound and failed runner capture | real host binding; the **terminal** UI context is a poisoned stub whose dialog methods throw, so any dialog that reached the terminal would fail the test. The "browser" is an HTTP client plus the fake-DOM page test, not a real browser |
| `test/cli-extension-load.test.js` | real bundled CLI subprocess loading, repository-local production `ExtensionRunner` capture/rebind, and host `ui_prompt_start` / `ui_prompt_end` lifecycle events (plus the retained temporary probe) | real bundled CLI child process, isolated config dir, RPC mode, no prompt and no model call |
| `test/compat.test.js` | refusal on unsupported version, changed UI seam, or missing installation; positive control | real loader/runner, fake package roots |
| `test/host-package.test.js` | host discovery from `argv`, realpath/symlink entry resolution, anchored fallback resolution, explicit missing/Bun-entry failures, override validation, host fetch-error cause formatting and bad-port classification (both the test-harness copy and the production `src/core/bridge-server.js` helpers, including token redaction and cyclic causes), no personal paths / no bundled-CLI import in the repo | unit + static guards |
| `test/runner-capture.test.js` | injected capture fail-closed diagnostics, realpath/symlink bundle ordering, single-candidate fail-closed behavior, bare-specifier fallback and idempotent marker reuse | focused capture unit tests |
| `test/questionnaire-diagnostic.test.js` | the real questionnaire cannot be answered and terminates without approval | opt-in via `PI_BROWSER_UI_QUESTIONNAIRE_PATH` (read-only), skipped otherwise |

```bash
# opt-in diagnostic against the installed questionnaire (read-only)
PI_BROWSER_UI_QUESTIONNAIRE_PATH="$HOME/.pi/agent/extensions/questionnaire.ts" \
  node --test test/questionnaire-diagnostic.test.js
```

### Still unverified — requires a human at a real terminal and browser

Automated tests do **not** include a real TUI session or a real browser. To accept the
prototype, run manually:

1. `pi -e ./extensions/browser-interaction/index.js` in an interactive terminal; confirm
   the transcript shows the `Browser UI ready:` URL and no error.
2. Open the URL in a browser; confirm `Connected · no pending prompts`.
3. Confirm the Session status panel shows the current cwd, Git branch, session token totals and
   context tokens/window/percent; missing values should say Unknown rather than zero. Use the
   Current model and thinking panel to choose an allowlisted model and thinking level; confirm
   the panel reports the effective model and host-clamped thinking level without claiming turn
   completion. Then use the Chat panel to send a short multiline message while the session is idle;
   confirm the user message and assistant output appear in the browser, the assistant
   row updates while it streams, and the terminal is not used as a fallback. During a
   response, choose Steer and Follow-up and confirm each reports accepted/queued rather
   than executed; Normal is rejected while busy. Press Stop during a response and confirm
   it reaches the current session's abort path. Unknown slash commands should be visibly
   rejected. Expand thinking/tool disclosures and confirm long output starts collapsed,
   then scroll upward while a row streams to confirm the page does not pull to the bottom.
4. Confirm the Subagents panel distinguishes RPC unavailable, timeout, failed-reply and
   empty/omitted states. With a live pi-subagents owner, press **Refresh** and verify fleet
   display keys and async run ids remain separate; press **View transcript** for a listed async
   id and confirm only a bounded transcript tail appears. There must be no spawn/stop/steer,
   scheduler/configuration, filesystem or artifact controls/paths.
5. Ask the agent (or an extension command such as `/timed`) to raise a standard dialog;
   confirm it appears **only** in the browser (none in the terminal) and that the
   original flow continues with your answer. Confirm a host status integration still sees
   the waiting span (`ui_prompt_start` / `ui_prompt_end`).
6. Reload the browser page while a prompt or chat stream is pending; confirm the current
   active-branch chat history and same prompt reappear without duplicate rows.
7. Press **Reload Pi session** in the page (also with a prompt pending): confirm the
   pending prompt ends as non-approval, the page reconnects by itself to the new
   generation **without a new URL or token**, and old prompts cannot be answered any more.
8. Trigger a `ctx.ui.custom` interaction (for example the `questionnaire` tool); confirm
   the browser reports it as unsupported, the terminal shows no component, the tool fails
   explicitly and the standard confirm path still works afterwards.
9. Run `/browser-ui stop`, then `/browser-ui status`, then `/browser-ui start`; confirm
   the port closes, pending prompts end as non-approval, and the new URL works (this is
   the only flow that needs the terminal again, and only because the user asked for it).

Until those steps are performed, live TUI + browser interaction and live reload must be
treated as unverified. This is the interaction/lifecycle part of the MVP, not the finished
GUI, and it carries no release identity or license: it is not intended for publication or
installation.
