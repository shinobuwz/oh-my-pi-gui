# oh-my-pi-gui — browser GUI host for a Pi agent session (public SDK)

This repository implements a local browser GUI for a Pi agent session. The host process
(`npm start` / `node src/host/main.js`) creates **its own session through Pi's public SDK**
(`createAgentSession()`), binds a browser-driven `ExtensionUIContext` with
`session.bindExtensions({ uiContext, mode: "tui" })`, and serves the existing loopback page
(`src/browser/*`). Chat, standard dialogs, model/thinking, session status and the read-only
pi-subagents panel are all driven from the browser; the terminal is only needed to start and
stop the host.

The previous prototype attached the browser to a *running TUI session* by hooking Pi's
private UI seam. That route has been **removed from the working tree**: the private entry
point (`extensions/browser-interaction/`), the capture/rebind adapters
(`src/adapter/runner-capture.js`, `src/adapter/ui-adapter.js`, `src/adapter/host-package.js`,
`src/adapter/browser-bridge.js`, `src/adapter/compat.js`) and the shell bridges that only
served it (`src/adapter/chat-bridge.js`, `model-bridge.js`, `status-bridge.js`,
`subagents-bridge.js`) no longer exist. Their code and evidence remain in git history at the
previous change's Commit A (`0959a48`, `openspec/changes/browser-interaction-spike`).

The reusable pieces stay as **single implementations** in the new architecture:
`src/core/bridge-server.js` (token/Host/Origin/bad-port self-check), `src/core/request-store.js`
(dialog request model), `src/browser/*` (page and incremental rendering), plus the shared pure
logic migrated into `src/core/`: `chat-messages.js`, `model-catalog.js`, `git-status.js`,
`subagents-rpc.js`.

## Start

```bash
npm start                          # session cwd = this directory, URL file = .browser-ui/url
npm start -- --cwd <dir> --url-file <path>
node src/host/main.js --help       # usage and the SDK resolution order
```

- The SDK is imported by absolute path (never a bare specifier): `PI_GUI_SDK_PATH` →
  `PI_GUI_PACKAGE_ROOT` → common global npm roots → `npm root -g`. An explicit
  `PI_GUI_SDK_PATH`/`PI_GUI_PACKAGE_ROOT` that does not contain the SDK is a startup
  error (no silent fallback), and a missing/unknown export shape exits non-zero without
  publishing a URL.
- A new session is created in Pi's normal session directory for the cwd, so `pi -c` can
  continue it later. User settings, credentials and defaults are not modified.
- The bridge starts and publishes the URL **before** `bindExtensions`, because `session_start`
  handlers may raise dialogs (project trust, login, extension prompts) that can only be
  answered from the page. `Pi GUI host listening: <url>` is printed as soon as the page is
  reachable; `Pi GUI host ready` then reports the bound session.
- The host binds `bindExtensions({ uiContext, mode: "tui" })`, so interaction-gated
  extensions are enabled while `custom` stays explicitly unsupported. Pi's own runner keeps
  emitting `ui_prompt_start`/`ui_prompt_end`; the host fabricates no events.
- On SIGINT/SIGTERM (and any exit path) pending dialogs end with their non-approval result,
  the listener closes, the URL file is removed and the session handle is released. There is
  **no in-place reload**: the page's reload request is refused with `reload_unavailable`;
  restart the host process instead.

Environment variables:

| Variable | Meaning |
| --- | --- |
| `PI_GUI_SDK_PATH=<file-or-root>` | explicit Pi SDK module (`dist/index.js`) or package root; takes precedence over every discovery step |
| `PI_GUI_PACKAGE_ROOT=<dir>` | explicit `@earendil-works/pi-coding-agent` package root |
| `PI_GUI_SMOKE=1` | opt-in switch for `test/sdk-smoke.test.js` (real installed SDK) |
| `PI_GUI_SMOKE_AGENT_DIR=<dir>` | agent directory the smoke test reads (read-only; default `~/.pi/agent`) |
| `PI_GUI_SMOKE_SUBAGENTS_PATH=<file>` | installed pi-subagents entry for the opt-in read-only RPC smoke case |
| `PI_GUI_EXTRA_EXTENSIONS=<paths>` | comma/semicolon separated extra extension paths **appended** to Pi's normal discovery for this GUI session (max 16). Used by the acceptance probe; no dedicated test covers the env plumbing, so treat it as an undocumented-stability knob. |

### `ctx.ui` support in the SDK host (first version)

| Member | Behaviour |
| --- | --- |
| `confirm` / `select` / `input` / `editor` | Browser dialog via `/api/state` + `/api/answer`, contract return values (`boolean`, `string`/`undefined`). Timeout, cancel, abort, duplicate, late or disconnected answers end as non-approval and never re-run the flow. |
| `custom` | Unsupported by design: the original call fails immediately, the browser shows an unanswerable notice, the factory is never invoked and no answer is invented. |
| `notify` / `setStatus` | Recorded in host memory and logged on the host terminal (the first-version page has no notification/status pane yet). |
| `setWidget` (string lines), `setTitle`, `setEditorText`/`getEditorText`, `setWorkingMessage`/`setWorkingVisible`/`setWorkingIndicator`, `setHiddenThinkingLabel`, `setToolsExpanded` | Kept in host memory as a safe no-op with an explicit one-time log; no page pane for them yet. |
| `theme` | Plain-text fallback (`fg`/`bg`/`bold`/… return the text unchanged) so extensions that style output do not throw; colours are an explicit downgrade. |
| `onTerminalInput`, `setFooter`, `setHeader`, `addAutocompleteProvider`, `setEditorComponent`, `getAllThemes`, `getTheme`, `setTheme` | Not available in a browser host: safe no-op/empty result plus an explicit one-time log. Nothing is silently ignored. |

### Browser chat in the SDK host

The page chat is driven by the session the launcher owns, and `src/browser/app.js` was not
changed: the host keeps the exact browser contract (per-message `revision`, `since` deltas,
`historyIds`, and the same `available`/`phase`/`canSend`/`canSteer`/`canFollowUp`/
`hasPendingMessages`/`leafId`/`revision`/`messages`/`messagesFull`/`lastError` fields).

- **History** comes from the public `session.sessionManager.buildContextEntries()` (the
  active, compaction-aware branch; `getLeafId()` for the leaf). The host never reads session
  files and never invents rows: if the manager cannot answer, the snapshot says the history
  is temporarily unavailable and stays empty.
- **Streaming and tools** come from `session.subscribe()` (`message_start`/`update`/`end`,
  `tool_execution_*`, `agent_start`/`agent_end`/`agent_settled`, `compaction_end`,
  `entry_appended`). Live rows are reconciled against the canonical active branch on
  `agent_end`, so a persisted message — including a tool result — never appears twice.
  Thinking and tool output stay bounded, collapsible text; sensitive argument keys and
  bearer/assignment secrets are redacted; unknown provider blocks are dropped.
- **Sending** uses `session.prompt(text, { expandPromptTemplates: true })`. While the
  session is streaming the selected delivery is passed as `streamingBehavior: "steer"` or
  `"followUp"`; an idle Steer/Follow-up selection is normalized to an immediate normal send
  and reported as normalized. The response reports acceptance or queueing, never execution:
  `prompt()` resolves only when a normal turn finishes, so the host observes that promise
  separately and shows an asynchronous failure (for example a missing model or API key) as
  `message delivery failed after acceptance: …` in the chat status. While the session is
  neither idle nor streaming (for example while compacting) the phase is `unknown` and every
  send is refused with `busy` instead of being accepted and failing.
- **Stop** calls `session.abort()`. The request returns immediately with `phase: "stopping"`
  and an asynchronous abort failure is surfaced in the chat status.
- **Slash commands fail closed in this first version.** Only names in the public catalog are
  forwarded: extension commands from `session.extensionRunner.getRegisteredCommands()`,
  file-based prompt templates from `session.promptTemplates`, and `skill:<name>` commands
  from `session.resourceLoader.getSkills()`. A built-in or unknown command is rejected with
  `unsupported_command` and never sent to the model as plain text; if the session does not
  expose its command list, slash input is refused with `commands_unavailable`. Slash command
  failures are surfaced through the public `extensionRunner.onError` stream. The page has no
  command list/picker yet.
- **Startup fail-closed checks:** `src/host/host.js` refuses to start when the created
  session lacks the public members the chat needs (`prompt`, `abort`, `subscribe`, `isIdle`,
  `isStreaming`, `sessionManager.buildContextEntries`) or the public actions the model
  controls need (`setModel`, `setThinkingLevel`) instead of degrading silently. The
  read-only subagents panel is the one deliberately optional slice: when the installed SDK
  cannot even expose the shared extension event bus, the host logs the exact reason, leaves
  the panel unattached and the page keeps showing `Unavailable` — see
  [Subagents in the SDK host](#subagents-in-the-sdk-host).

### Model/thinking and status in the SDK host

The page panels are driven by the session the launcher owns, and `src/browser/app.js` was not
changed: the host keeps the exact browser contract for both sections
(`available/model/thinkingLevel/thinkingLevels/candidates/revision/lastError` and
`available/cwd/git/tokens/contextUsage/revision`).

- **Candidate source:** `session.scopedModels` when the session has scoped models (each entry
  may pin a thinking level), otherwise the public sync snapshot
  `session.modelRuntime.getAvailableSnapshot()` — the same runtime that resolves the
  session's model and auth, so no extra network or model call is involved. In the checked
  installation (Pi 0.85.1) `scopedModels` was empty and the runtime snapshot listed the 12
  authenticated models of the user's agent directory. A session that cannot report
  candidates shows an empty list plus `model candidates are temporarily unavailable` instead
  of invented entries.
- **Allowlist:** the browser receives only `key` (`provider/id`) plus display fields
  (`provider`, `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`). Provider
  configuration, base URLs, headers and credentials never cross the boundary. `/api/model`
  accepts only a `generation` and a `key` that is in the allowlist rebuilt from the *current*
  session state; anything else is refused with `model_not_allowed` (409) before the session
  is asked. The host model object the key maps to is the only value passed to `setModel()`.
- **Model selection:** `session.setModel(model)` is called without options, so the change is
  session-only (Pi's global model/thinking defaults are never written). The response echoes
  the host's actual effective model and thinking level read back from `session.model` /
  `session.thinkingLevel`. A session that cannot activate the model (for example without a
  usable API key) is reported as `model_change_failed` (409) with the previous model still
  active; the provider's own error text stays in the host log.
- **Thinking:** the page is offered `session.getAvailableThinkingLevels()` (bounded to Pi's
  public level set), and `session.setThinkingLevel(level)` is called without options. The
  response reports the effective (clamped) level and `clamped: true` when the host adjusted
  the request; `invalid_thinking_level` (400) refuses anything outside the public set.
- **Status:** cwd comes from `sessionManager.getCwd()`, token totals stay the aggregation of
  the active branch (`sessionManager.getBranch()`, then `getEntries()`), context usage comes
  from `session.getContextUsage()` plus `session.model.contextWindow`, and the Git branch is
  one read-only query (`symbolic-ref` → `rev-parse`, fixed argv, `shell: false`, timeout and
  `maxBuffer` bounds) refreshed after session events. Missing values stay `Unknown`/`null`
  instead of `0`, failures are reported only as reason codes (`git_unavailable`,
  `git_timeout`, `git_output_limit`, `not_repo`, `git_error`, `detached_head`), and
  `dispose()` clears the subscription, the timer, the Git child and the session reference so
  a late callback cannot write after shutdown.

The host adapters deliberately reuse the shared building blocks instead of re-implementing
them: `src/host/models.js` imports the pure sanitizers
(`modelKey`/`snapshotModel`/`safeThinking`/`THINKING_LEVELS`) from `src/core/model-catalog.js`,
`src/host/status.js` drives the shared `StatusBridge` from `src/core/git-status.js` through a
read-only view over the SDK session, and `src/host/subagents.js` wraps the shared
`SubagentsBridge` from `src/core/subagents-rpc.js`, so the Git/usage semantics, DTO bounds
and redaction rules are not duplicated.

### Subagents in the SDK host

The page panel is unchanged (`src/browser/app.js` keeps rendering the same
`available/state/generation/fleet/asyncSnapshot/error/revision` contract). The host attaches a
read-only adapter (`src/host/subagents.js`) as the last step of `startHost`, after extensions
bind, and leaves the initial ping → status bind unawaited so a missing or slow owner never
delays startup.

- **Public channel — the host owns the shared extension event bus.** pi-subagents registers
  its read-only RPC owner with `pi.events.on("subagents:rpc:v1:request", …)` while its
  extension factory runs, and Pi hands every extension the single `EventBus` its resource
  loader owns. A session exposes no public path to that bus (`session.extensionRunner` is
  public, but its `runtime` has no event-bus member). The host therefore creates the bus with
  the public `sdk.createEventBus()` and passes it to Pi's own `sdk.DefaultResourceLoader`,
  which keeps the default discovery (`cwd`, `sdk.getAgentDir()`,
  `SettingsManager.create(cwd, agentDir)`) that `createAgentSession()` would have used
  itself; the session is then created with that loader. No private seam, no internal
  extension and no extra extension in the user's load set is involved.
- **Verified against the installed packages.** Pi 0.85.1 resolved the *same* 11 user
  extension paths with the default loader and with the host-owned bus (zero load errors), and
  the real pi-subagents 0.67.0 owner answered the host's ping/status over that bus (opt-in
  `PI_GUI_SMOKE=1` test, no model call, no subagent started).
- **Read-only capability.** The list projects the public fleet entries plus the separate
  async snapshot runs; **View transcript** is on-demand only, uses the fixed
  `{ id, view: "transcript", lines: 80 }` request for an async run id that the *current*
  successful status response returned, and **Refresh** sends one untargeted status request
  (public `subagent:async-started`/`async-complete`/`child-status`/`rpc ready` hints are
  coalesced into one refresh within a 100 ms window). Only `ping` and `status` are ever sent:
  no spawn/manage/schedule/steer/interrupt/stop/resume path exists, so the panel cannot
  change session state.
- **Identity separation and bounds.** A fleet display key is never a run id and is refused
  with `not_found` before any RPC is sent; only ids in the current status allowlist can
  target a transcript. Fleet entries, runs, children and result summaries are bounded
  (32/32/8/8), text fields are clipped, timestamps use the public `updatedAt` (the legacy
  `lastUpdate` is never forwarded) and secret shapes (`Bearer …`, `key=`/`token=`/`secret=`/
  `password=`) are redacted while ordinary transcript paths stay readable. Raw task fields,
  artifact paths and artifact access are never exposed.
- **Honest unavailability.** `ready-empty` (no work), `error` (owner refused),
  `timeout`/`unavailable` (no RPC owner — the case where pi-subagents is not installed) and
  unattached (the host shape has no extension-bus exports) stay visibly distinct; the panel
  never shows invented rows, and a failed refresh still returns its snapshot so the page
  shows the current state instead of stale data. The initial `loading` state always settles
  within the bounded 1.5 s RPC timeout instead of leaving the panel loading forever.
- **Known limitation:** pi-subagents deliberately skips its parent-side registration when
  `PI_SUBAGENT_CHILD=1` is set (a subagent child process). Launching the GUI host from inside
  such a process therefore leaves the panel `Unavailable · timeout`; run `npm start` from a
  normal shell.
- **Teardown:** `detach`/`close`/`exitCleanup`/`cleanupFailedStart` dispose the adapter
  (hint subscriptions, pending RPC requests, timers) and, after the session is released,
  clear the shared event bus; a closed host sends no further read-only RPC.

## Browser behaviour

- The token is read from the URL fragment (`#t=…`) and kept in `sessionStorage`; the fragment
  is removed from the visible URL. It is sent only as an `Authorization: Bearer` header to
  the loopback API.
- Each pending prompt shows the original title, message, options or prefill. **Nothing is
  submitted without an explicit click** (Yes/No, option + submit, text + submit, or
  `Cancel without answering`); there is no default answer and no auto-confirmation.
- Buttons disable while a reply is in flight; rejected replies are shown with their error
  code and the prompt stays pending.
- The Chat panel accepts multiline text only on explicit Send. The Delivery selector offers
  **Normal** (idle-only), **Steer** (queued during a response), and **Follow-up** (queued
  until the response finishes); the host passes busy selections through
  `session.prompt(..., { streamingBehavior })` and reports idle steer/follow-up selections as
  immediate normal delivery. Assistant text, thinking, tool calls and tool results arrive as
  bounded text-safe blocks; thinking and long tool output are collapsed by default. Rows
  update in place and keep the browser's reading position. Stop calls the current session's
  `abort()`.
- `/api/state` accepts an optional `since=<chat revision>` query parameter. Without a valid
  1–12 digit value it keeps the complete-snapshot behaviour for older clients. A valid
  revision behind the current chat returns `messagesFull: false`, only messages whose
  per-message `revision` changed, and the complete ordered `historyIds` list; an equal
  revision returns no messages and `historyIds: null`; an invalid or future revision returns
  `messagesFull: true` with all messages and ids. The page sends `since` after it learns a
  revision, merges the delta into its id/order cache, removes ids no longer in `historyIds`,
  and rebuilds a chat row's blocks only when that row's message revision changes, including
  the currently streaming row.
- The read-only Session status panel shows cwd, Git branch, session token totals and context
  usage. Git refreshes are asynchronous and bounded; non-repository, unavailable or failing
  Git is shown as Unknown rather than exposing command errors.
- The Current model and thinking panel uses explicit **Use model** and **Use thinking level**
  submissions. It displays the host's effective state after each request, including a
  `setModel()` authentication failure or thinking-level clamp.
- The Subagents panel keeps opaque fleet display keys separate from real async run ids.
  Refresh is manual; **View transcript** is on-demand and sends only the current generation,
  run id, `view: "transcript"` and the fixed server-side line limit. Unavailable, timeout,
  failed-reply and empty/omitted status remain visibly distinct.
- Busy normal sends, unsupported delivery modes and unknown slash commands are rejected
  visibly; queued steer/follow-up responses say they were accepted/queued, not executed,
  while streaming extension-source slash commands are identified as immediate and not part of
  that queue.
- If the page loses the connection it reports `Disconnected…` and keeps retrying; pending
  prompts stay on the host, and they reappear with the same request ids on reconnect.
- The page's **Reload Pi session** control is refused with `reload_unavailable`: the host owns
  its session process, so there is no in-place reload. Restart the host process to get a new
  session, a new token and a new URL. Closing the browser page never ends the session.

## Security model

- The server binds `127.0.0.1` on an ephemeral port only.
- Every request must carry `Host: 127.0.0.1:<port>`; API reads require the bearer token.
- Writes additionally require `Origin: http://127.0.0.1:<port>` (and reject cross-site
  `Sec-Fetch-Site`), so another page in the browser cannot drive the session.
- Bodies are limited to 320 KiB; `confirm` answers must be booleans, `select` answers must
  match the offered options, `input`/`editor` answers are length-limited, and chat text is
  bounded before it reaches `session.prompt()`.
- Replies are accepted once per request id; duplicates, late replies, unknown ids and type
  mismatches are rejected and never reach the host flow.
- The page is served from three allow-listed local files (`index.html`, `app.js`, `app.css`);
  there is no path input, no directory listing and no file read/write API.
- Everything from the host is rendered with `textContent` (no `innerHTML`), and the response
  CSP is `default-src 'none'` with same-origin script/style/connect only.
- Subagent routes require the bearer token, exact loopback Origin and exact generation-bound
  body fields. Fleet keys cannot target transcript requests; only async ids retained by the
  current status cache can do so. DTOs are bounded and best-effort redacted; child-task
  transcript text is real child output and may contain host paths or sensitive text. The page
  boundary remains loopback-only and bearer-token protected, with no raw task fields, artifact
  access or mutation methods exposed as controls.
- The page never approves on timeout or disconnect; non-approval results are `false`
  (`confirm`) or `undefined` (`select`/`input`/`editor`), matching the host contract.

## Lifecycle

| Event | Behaviour |
| --- | --- |
| browser disconnect | pending prompts stay on the host; nothing is approved, nothing is sent to the terminal |
| explicit cancel in the browser | the caller receives the non-approval value |
| consumer `timeout` option | the caller receives the non-approval value; late browser replies are rejected |
| consumer `AbortSignal` | same as timeout |
| browser "Reload Pi session" request | refused with `501 reload_unavailable`; restart the host process instead |
| SIGINT / SIGTERM / `uncaughtException` / `unhandledRejection` | pending prompts end without approval, the listener closes, the URL file is removed and the session handle is released (exit code 130/143/1) |
| process `exit` | synchronous best-effort cleanup of the same resources |
| a GUI session is separate from any TUI session | the host never attaches to another Pi process; `pi -c` can continue the created session file later |

## Questionnaire and custom components

The questionnaire is deliberately **not** supported in the first version; a structured form
is a scope decision, not a pending bug fix.

`ctx.ui.custom(factory)` hands over a terminal component whose closure owns its own data
(questions, options, answers), so the browser cannot read or answer it. What happens instead:

- the browser shows an explicit *unsupported interaction* notice;
- the original call fails immediately with an explicit error — it does not hang, does not
  fall back to the terminal and never produces an invented or auto-confirmed answer;
- standard `confirm`/`select`/`input`/`editor` dialogs keep working from the browser, and
  Pi's prompt lifecycle notifications still fire for the unsupported interaction;
- ordinary questions are expected to be asked in chat; plain chat text is not, and will not
  be presented as, a structured questionnaire result.

This is covered by `test/host-ui-context.test.js` (the `custom` member fails without calling
its factory and creates an unanswerable, 409-rejected browser notice). The previous
read-only diagnostic against the installed questionnaire was removed together with the
private-seam route it drove; final real-browser acceptance still includes triggering
`ctx.ui.custom` (for example the `questionnaire` tool).

## Requirements

- Node.js 24.x (verified with v24.16.0) and npm 11.x
- An installed Pi coding agent (`@earendil-works/pi-coding-agent`); verified against
  **0.85.1**. The host checks the public entry points and export shape at startup and fails
  closed with a reason when the installed shape is not supported (no version lock file, no
  silent fallback).
- No dependency installation is required for the host or its tests.

## Automated verification

```bash
npm test                      # full suite (node --test)
npm run check                 # syntax check of every source and page file
npm run test:host             # the SDK host test files (same runner, subset)

# opt-in real-SDK smoke (no model call, temporary session directory)
PI_GUI_SMOKE=1 node --test test/sdk-smoke.test.js
```

The second smoke case also needs pi-subagents installed at
`~/.pi/agent/npm/node_modules/pi-subagents/index.ts` (override with
`PI_GUI_SMOKE_SUBAGENTS_PATH`) and a shell where `PI_SUBAGENT_CHILD` is not set; it is skipped
with that exact reason otherwise.

Test inventory and the real-vs-stub boundary:

| Test file | Covers | Boundary |
| --- | --- | --- |
| `test/request-store.test.js` | pending lifetime, explicit answers, non-approval exits, duplicate/late rejection, limits | pure host-store unit tests |
| `test/bridge-server.test.js` | undici/Chromium bad-port boundaries (full reference port table compared item by item, undici entries re-verified against the running Node client), bound-client self-check, bounded never-settling self-check timeout with redirect: "manual", client-rejected rebind including a code-only `ERR_UNSAFE_PORT`, ordinary network-error diagnostics, self-check token redaction in diagnostics/logs/thrown errors and ten-attempt fail-closed behavior, token/Host/Origin/size/content-type/method checks, asset allow-list, reconnect replay, prompt text kept as data | real HTTP plus injected bind and fetch seams |
| `test/browser-assets.test.js` | no dynamic HTML sinks, no external origins, fragment token + Authorization header, submit only on user action | static guards on the served page |
| `test/browser-page.test.js` | the served page logic runs against a strict fake DOM: token handling, delivery selection and accepted-vs-executed wording, thinking/tool folding, chat rendering/stream reconciliation, multiline submission, Stop, prompt cards for every kind, explicit submissions, cancel/dismiss, rejection feedback, 401 handling | fake DOM (a real browser is still required for final acceptance; `innerHTML` throws in the fake DOM) |
| `test/chat-server.test.js` | authenticated generation-bound chat state/message/Stop routes and cross-site/stale rejection | real HTTP against the real server with a session-control fixture |
| `test/model-server.test.js` | authenticated model/thinking routes, exact candidate-key forwarding, generation and Origin rejection | real HTTP against the real server |
| `test/model-page.test.js` | candidate selectors, explicit submissions, effective-state and rejection feedback | strict fake DOM |
| `test/subagents-server.test.js` | authenticated read-only details/refresh routes, exact body fields, generation and Origin rejection | real HTTP against the real server with a session-control fixture |
| `test/subagents-page.test.js` | bounded fleet/async rendering, manual transcript detail, text-only output and visibly distinct timeout/omitted states | strict fake DOM |
| `test/git-status.test.js` | the shared Git/usage implementation (`src/core/git-status.js`): active-branch usage aggregation, context null/known values, bounded cwd, injected Git normal/unborn/detached/non-repository handling, event refresh and generation disposal | public-API-shaped unit fixtures |
| `test/subagents-rpc.test.js` | the shared read-only pi-subagents RPC consumer (`src/core/subagents-rpc.js`): correlated public ping/status RPC, generation-scoped fleet/async projection, identity separation, fixed transcript params, timeout/error distinction and redaction | public event-bus fixture |
| `test/host-sdk-loader.test.js` | SDK discovery (env overrides, global npm roots, `npm root -g`, fail-closed explicit overrides) and export-shape validation, plus the repository portability guards (no hardcoded personal installation paths, no import of the bundled CLI entry) | temporary fixture roots, injected `npm root -g`; no installed package, no network |
| `test/host-session.test.js` | `startHost` against a fake SDK: session creation, chat/model/status attach/detach, fail-closed startup, resource release on close and the synchronous exit path | fake `AgentSession` |
| `test/host-ui-context.test.js` | the browser-driven `ctx.ui`: dialog kinds, Pi-compatible return types, non-approval exits, explicit `custom` failure with an unanswerable notice, notify/setStatus recording and the safe no-op downgrades | `RequestStore` + fake dialog consumers |
| `test/host-chat.test.js` | SDK chat adapter on a fake session: browser contract fields, idle/streaming/unknown phase migration, revision + `since` protocol, live-vs-canonical reconciliation (including the persisted toolResult case), delivery mapping with the exact `prompt()` options, slash-command allowlist and fail-closed refusal, stop → `abort()`, `lastError` after acceptance, redaction and history-failure reporting | public-API-shaped `AgentSession` fixture; no model call |
| `test/host-chat-server.test.js` | real HTTP `/api/message`, `/api/stop` and `/api/state` round trips through the host bridge with a fake session: idle normal, streaming steer/follow-up, incremental state, stop; rejection paths (missing/wrong token, wrong Origin, cross-site `Sec-Fetch-Site`, extra fields, stale generation, unknown slash command, unknown delivery, oversized text) and released-session refusal | real loopback HTTP server, fake `AgentSession` |
| `test/host-model.test.js` | SDK model/thinking adapter on a fake session: scoped/available candidate allowlist and deduplication, sanitized snapshots (no credentials/baseUrl/headers), unknown-key refusal before `setModel()`, effective model/level read-back, missing-auth throw and `false` return keeping the previous model, thinking clamp echo, session-only calls (no `persist`) and disposal | public-API-shaped `AgentSession` fixture; no model call |
| `test/host-status.test.js` | SDK status adapter on a fake session: cwd reader plus explicit fallback, active-branch usage aggregation with an unknown total when a component is missing, context usage/window, bounded Git argv (`shell: false`, timeout, maxBuffer) with reason-code-only failures, event refresh, disposal and late-callback rejection | public-API-shaped `AgentSession` fixture with an injected `execFile`; no real repository or subprocess |
| `test/host-subagents.test.js` | the host-owned extension-bus channel (same bus, default discovery, explicit reasons instead of a private seam), the read-only adapter over a fake pi-subagents owner (bounded fleet/async lists with public time fields, fleet-key-vs-run-id separation, allowlist-only detail with the fixed transcript params, empty/error/timeout distinction, redaction with ordinary paths preserved, body validation, hint-burst coalescing, no writes after dispose) and the lifecycle attach/detach plus `not_attached` contract | fake extension bus + fake RPC owner; no model call, no real subagent, no installed package |
| `test/host-subagents-server.test.js` | real HTTP `/api/state` `subagents` section plus `POST /api/subagents/details` and `POST /api/subagents/refresh` through the host: bounded projection, exact transcript params, redaction, refresh round trip, hint coalescing, unavailable owner, unattached host shape with a logged reason, resource-load failure refusing startup, and the existing token/Host/Origin/extra-field/stale/method rejections plus no-write-after-shutdown | real loopback HTTP server, fake SDK bus and fake RPC owner; no model call, no real subagent |
| `test/host-controls-server.test.js` | real HTTP `/api/model`, `/api/thinking` and `/api/state` round trips through the host bridge with a fake session and an injected Git double: candidate-key forwarding, effective model/level echo, clamp echo, activation failure keeping the previous model, plus the existing token/Origin/body/generation/method rejections and the serialized-payload leakage check | real loopback HTTP server, fake `AgentSession` |
| `test/host-server.test.js` | real HTTP `/api/state` + `/api/answer` dialogs, unauthenticated/cross-site/malformed answer rejection, the explicit `reload_unavailable` refusal, the served-page dialog/chat snapshot render, and listener release with non-approval dialogs on close | real loopback HTTP server, fake SDK and Git double |
| `test/host-main.test.js` | launcher argument parsing, `--help`, exit codes, fail-closed startup reporting, signal-driven shutdown, synchronous `exit` cleanup and the direct `node src/host/main.js` entry | injected host starter plus a real subprocess for `--help` / missing-SDK fail-closed |
| `test/sdk-smoke.test.js` | opt-in against the installed SDK: our UI context bound in `tui` mode, a real extension calling it, the public chat/model/status accessors on a real session, and the real pi-subagents owner answering the read-only ping/status over the host-owned bus | real installed SDK, temporary session directory, no model call; skipped unless `PI_GUI_SMOKE=1` |

### Still unverified — requires a human at a real terminal and browser

Automated tests do **not** include a real TUI/browser combination. To accept the SDK host,
run these steps manually (the private-seam TUI-attachment path is no longer part of this
repository):

1. `npm start` in a normal shell; confirm the terminal prints the
   `Pi GUI host listening: http://127.0.0.1:<port>/#t=<token>` URL (and `Pi GUI host ready`
   with the session file) and no error.
2. Open the URL in a browser; confirm `Connected · no pending prompts`.
3. Confirm the Session status panel shows the current cwd, Git branch, session token totals
   and context tokens/window/percent; missing values should say Unknown rather than zero. Use
   the Current model and thinking panel to choose an allowlisted model and thinking level;
   confirm the panel reports the effective model and host-clamped thinking level. Then use
   the Chat panel to send a short multiline message while the session is idle; confirm the
   user message and assistant output appear in the browser, the assistant row updates while
   it streams, and the terminal is not used as a fallback. During a response, choose Steer
   and Follow-up and confirm each reports accepted/queued rather than executed; Normal is
   rejected while busy. Press Stop during a response and confirm it reaches `abort()`. Unknown
   slash commands should be visibly rejected. Expand thinking/tool disclosures and confirm
   long output starts collapsed, then scroll upward while a row streams to confirm the page
   does not pull to the bottom.
4. Confirm the Subagents panel distinguishes RPC unavailable, timeout, failed-reply and
   empty/omitted states. With a live pi-subagents owner, press **Refresh** and verify fleet
   display keys and async run ids remain separate; press **View transcript** for a listed
   async id and confirm only a bounded transcript tail appears. There must be no spawn/stop/
   steer, scheduler/configuration, filesystem or artifact controls/paths.
5. Ask the agent (or an extension command such as `/timed`) to raise a standard dialog;
   confirm it appears **only** in the browser (none in the terminal) and that the original
   flow continues with your answer. Confirm a host status integration still sees the waiting
   span (`ui_prompt_start` / `ui_prompt_end`).
6. Trigger a `ctx.ui.custom` interaction (for example the `questionnaire` tool); confirm the
   browser reports it as unsupported, the terminal shows no component, the tool fails
   explicitly and the standard confirm path still works afterwards.
7. Reload the browser page while a prompt or chat stream is pending; confirm the current
   active-branch chat history and the same prompt reappear without duplicate rows.
8. Press **Reload Pi session** in the page; confirm it is refused with `reload_unavailable`
   and the page keeps working; then restart the host process and confirm the old URL/token is
   no longer accepted.
9. Stop the host with Ctrl+C (SIGINT); confirm pending prompts end as non-approval, the port
   closes, and the `.browser-ui/url` file is removed.

A CDP-driven acceptance run (headless Chrome against a real session and a real model) covered
loading/token flow, the status panel, model and thinking switching, chat with real streaming
and Stop, unknown slash rejection, scroll retention, standard dialogs answered in the page
(plus host-emitted `ui_prompt_start`/`ui_prompt_end` for all five kinds), questionnaire
reported as unsupported, the subagents panel with a real async run row, reconnect after a
page reload (same prompt id, no duplicate rows), `reload_unavailable` and the security
rejections. What is **not** covered by that run: the terminal Ctrl+C path (this machine can
only hard-kill the process, which leaves the URL file behind while the port closes), and any
manual step that needs a real human at a real terminal. See
`openspec/changes/browser-gui-sdk/evidence.md` for the full acceptance table and the residual
list, and `tasks.md` for the known residuals (extension-side session controls, startup
liveness window, chat text not secret-redacted, acceptance fixtures not in the repo). This is a local prototype: it
carries no release identity or license and is not intended for publication or installation.
