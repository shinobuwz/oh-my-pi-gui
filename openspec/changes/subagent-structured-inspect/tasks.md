# Tasks：子代理结构化检视（宿主 inspect 通道）

公共约定见 [spec.md](spec.md)，验收结论与残余见 evidence.md（验收后写入）。本文件是唯一任务进度来源，由 Main 核对实际结果后更新。

路线决定（用户裁决）：走宿主侧路线，`bindExtensions` 改 `mode: "rpc"` 以解锁 pi-subagents 的宿主 inspect 协议；不提上游需求。代价（`ctx.mode !== "tui"` 扩展降级）已在 spec 中登记为接受项。

**写者序列**：`src/browser/index.html` 与 `src/browser/app.css` 归当前进行中的视觉 change（designer，run `7bc7899e`）；本 change 的页面工作组必须等它收工并经 Main 回读后再开始，避免同 worktree 双 writer 与共享 `npm test` 的互相干扰。宿主侧（`src/host/*`、`src/core/*`）也不得与它并行写入，因为 `npm test` 是共享观测面。

## 1. 绑定模式切换（解锁 inspect 通道）

状态：已实现并验证（宿主启动、rpc 模式对话框回归、真实 host E2E 均通过）

依赖：无（除写者序列等待）。导航：`src/host/host.js`（`HOST_UI_MODE`，当前 `"tui"`，注释说明为「启用 questionnaire 等交互扩展」）、`test/sdk-smoke.test.js`（opt-in，绑 `tui`）、README 第 6/45/306/378/411/425 行附近关于 `mode: "tui"` 与 questionnaire 的表述。

- [x] 1.1 `HOST_UI_MODE` 改为 `"rpc"`，注释改写为「rpc 保留对话框能力（confirm/select/input/editor 仍落浏览器），并解锁 pi-subagents 的宿主 inspect 命令；代价是 `ctx.mode !== "tui"` 的扩展（如 questionnaire、llama）降级」。
- [x] 1.2 同步 `test/sdk-smoke.test.js` 的绑定模式，并在其中断言 rpc 模式下对话框仍可用（现有 fake/真实扩展调用路径）。
- [x] 1.3 README 对应段落改写：删除/更新「`mode: "tui"` 使交互扩展启用」的说法，明确 questionnaire 由「custom 明确 unsupported」变为「该扩展在 rpc 模式下自行拒绝（UI not available）」，并说明这是本 change 的已知取舍。

### Scenario：模式切换不削弱对话框

- **WHEN** 会话以 `mode: "rpc"` 绑定，扩展触发 confirm/select/input/editor
- **THEN** 仍以浏览器对话框回答，返回值符合原契约
- **AND** 宿主的 `ui_prompt_start`/`ui_prompt_end` 生命周期不受影响

## 2. UI context 侧的结构化载荷截获

状态：已实现并单测覆盖

依赖：无（可与工作组 3 并行设计，但由同一 writer 串行落地）。导航：`src/host/ui-context.js`（`setWidget` 现把行存进 `widgets` Map 并 `degrade`；`MAX_WIDGET_LINES = 100`、`MAX_WIDGETS = 20`）、`src/core/` 现有纯逻辑模块风格（可与 bridge 分离单测）。

- [x] 2.1 `ui-context` 记录 **widget 更新事件**（而不只是当前状态）：对 `subagent-inspect` 键保留最近一次 `PI_SUBAGENT_INSPECT_JSON:` 行，并暴露一个有界读取/订阅接缝；`setWidget(key, undefined)`（命令的 emit-then-retract）不得抹掉刚捕获的载荷。
- [x] 2.2 新增 `src/core/` 纯函数模块：解析 `PI_SUBAGENT_INSPECT_JSON:<json>` 载荷 → 校验 `kind === "pi-subagents.inspect-reply"`、version、`requestId` 匹配 → 投影为有界结构（`messages[]` 的 role/kind/name/isError/text，条数 ≤200、单条 ≤1000 字，`task` ≤2000，`finalOutput` ≤8000，`truncated`），并复用既有脱敏（Bearer/凭证赋值/敏感路径字段）；路径字段一律不出现在输出。
- [x] 2.3 单测覆盖：正常载荷、requestId 不匹配、畸形 JSON、超长字段、凭证脱敏、扩展 error 载荷、以及「retract 后仍可读到上一次载荷」。

## 3. 宿主 inspect 调用（命令触发与错误归一化）

状态：已实现并单测 + 真实 host E2E 验证

依赖：工作组 2。导航：`src/host/subagents.js`（现有 `details()` 与状态保留逻辑）、`src/core/subagents-rpc.js`（现有 `detail()` 的 allowlist 与 `#asyncIds` 保留集、`SUBAGENT_RPC_*`、`SUBAGENT_LIMITS`）、`session.prompt()` 的扩展命令语义（pi 0.85.1 `agent-session.js:826-834`、`954`）。

- [x] 3.1 新增 `inspect(expectedGeneration, { id, childId, lines })`：复用 `#asyncIds` 保留集合与 generation 校验；`childId` 必须是当前快照里出现过的节点 id（无 id 的子节点直接 `invalid_body`/`not_found`，不猜测）；fleet key 永不接受。
- [x] 3.2 生成 `requestId`，调用 `session.prompt("/subagents-inspect-rpc …")`（**不得**走聊天桥，不得写入聊天历史），await 返回后从 UI context 读取关联载荷。
- [x] 3.3 超时（默认 5s）、同 generation 单飞并发、rpc 不可用/扩展未注册（命令不存在 → `prompt()` 返回 false 视为 not registered）都要有明确结果码，不重试风暴、不挂起。
- [x] 3.4 错误码映射（spec「页面 API」节）：`not_found`/`foreign_session`/`stale`/`no_active_session`/`invalid_request`/`internal`/未知 → `inspect_failed`。
- [x] 3.5 单测：真实命令路径用宿主测试里的假 session/uiContext 覆盖（命令不存在、超时、载荷不匹配、错误载荷、重复请求、streaming 中请求不打断聊天）。

## 4. 只读 HTTP 路由与安全

状态：已实现并单测 + 真实 host 安全路径验证

依赖：工作组 3。导航：`src/core/bridge-server.js`（`ROUTE_BODIES` 精确 body allowlist、subagents 分支、`validateExactBody`）、`test/bridge-server.test.js`、`test/host-subagents-server.test.js`。

- [x] 4.1 `ROUTE_BODIES` 增加 `/api/subagents/inspect: ["generation", "id", "childId", "lines"]`，与现有 subagents 分支同源的鉴权/Origin/Host/reloading 处理。
- [x] 4.2 只接受上面 4 个键（其余 400 `invalid_body`）；`lines` 与 `childId` 有类型/长度/范围校验；响应不含路径与凭据。
- [x] 4.3 单测：401/403/400（多余字段、错误类型）/404（未知 id 或 fleet key）/403（`foreign_session`）/409（`stale`、`stale_generation`）/503（`no_active_session`）/502（畸形回复）。

### Scenario：拒绝无效访问

- **WHEN** 缺令牌、伪造 Host/Origin、多余字段、fleet key 或非当前 generation
- **THEN** 拒绝且不触发任何扩展命令
- **AND** 响应中不出现宿主路径或凭据

## 5. 页面：结构化视图

状态：已实现并经真实浏览器验收（工作组 6 通过）

依赖：工作组 4 + 视觉 change 结束。导航：`src/browser/app.js`（subagent 渲染：`renderAsyncRun`、`renderSummaryList`、`subagent-detail` 现有「View transcript」路径）、`src/browser/index.html`（静态模板与 id/class 契约）、`test/browser-page.test.js`、`test/browser-assets.test.js`（no-innerHTML、无外部资源、契约 token）。

- [x] 5.1 async run 行增加「结构化视图」动作（默认收起、点击才请求）；展开后对**有 id 的**子节点提供同样动作，无 id 的子节点明确标注不可用原因。
- [x] 5.2 用 DOM + `textContent` 渲染：`task`、`label`/`status`、消息列表（role 标签 + kind 视觉区分 + tool 名称 + `isError` 标记）、`finalOutput`、截断提示；loading/错误/超时/`foreign_session` 明确文案。
- [x] 5.3 保留现有「View transcript」并说明两者差别；面板仍只读。
- [x] 5.4 页面测试：假 DOM 下渲染真实形状的载荷、错误载荷、截断载荷；保持 `innerHTML` 禁用与静态资源约束；新增 id/class 不破坏既有契约 token。

## 6. 真实浏览器验收

状态：已完成（真实 host + 真实子任务 + 页面自身动作，见 evidence.md）

依赖：工作组 1–5。导航：上一版验收方式（headless Chrome + 自写 CDP 驱动，零依赖；真实 SDK 会话 + 真实 pi-subagents）。

- [x] 6.1 真实会话跑一个真实子任务，点开结构化视图，核对 messages/task/finalOutput/截断提示与实际一致。
- [x] 6.2 回归：confirm/select/input/editor 仍在浏览器回答；questionnaire 降级文案如实且不挂起。
- [x] 6.3 安全与边界：无令牌/伪造 Origin/多余字段拒绝；`foreign_session` 场景（用其它 session 的 run id）明确报错。
- [x] 6.4 记录残余：thinking 与工具参数全文不可得、200 条/1000 字/64KB 上限、session 文件不可读时只能退回文本尾部。

## 7. 文档与证据收口

状态：已完成（README、evidence.md、知识收口均已落地）

依赖：工作组 6。

- [x] 7.1 README：新增结构化检视的能力与边界（能得到什么、得不到什么、上限与错误语义）、mode 变更的取舍。
- [x] 7.2 `evidence.md`：命令输出、截图/探针证据、残余清单。
- [x] 7.3 知识收口（按知识契约做有界维护）：把「宿主可为结构化检视改绑 rpc」与「`subagents-inspect-rpc` 的 mode gate 与边界」登记为合适 surface 的条目，避免下次重新调查。

## 实施记录（工作组 1–4，Main 回读后的结论）

改动文件：`src/host/host.js`（`HOST_UI_MODE = "rpc"` + 注释理由/代价）、`src/host/ui-context.js`（widget 更新捕获 + inspect 键专用 80KB 上限，可见 pane 的既有上限不变；retract 只清 pane 不清捕获）、`src/core/inspect-reply.js`（新增：解析/校验/有界投影）、`src/core/redaction.js`（新增：从 subagents-rpc 忠实提取的共享脱敏，正则逐字未变）、`src/core/subagents-rpc.js`（`inspect()` + 单飞 + 超时 + abort）、`src/host/subagents.js`（适配）、`src/core/bridge-server.js`（新路由 + 精确 body + lines 校验）、README、测试。

实际错误码集合（页面按此渲染）：`invalid_body`(400)、`unauthorized`(401)、`bad_origin`(403)、`foreign_session`(403)、`not_found`(404)、`stale_generation`(409)、`stale`(409)、`inspect_busy`(409)、`no_active_session`(503)、`inspect_unavailable`(503)、`commands_unavailable`(503)、`inspect_timeout`(504)、`inspect_failed`(502)。宿主自身的 `inspect_busy`/`inspect_timeout`/`inspect_unavailable`/`commands_unavailable` 是对 spec 中「单飞/超时/命令未注册」要求的落地命名。

真实 host E2E（探针扩展经 `PI_GUI_EXTRA_EXTENSIONS` 注入，用 pi-subagents 自身 RPC 起真实 async 子任务；临时产物在 `%TEMP%/pi-gui-ui/e2e/`）：

| 表面 | 结果 |
|---|---|
| rpc 模式对话框回归 | ✅ 探针 `ctx.ui.confirm` 落到页面 pending，经 `POST /api/answer` 回答 `true`，扩展收到 `{value: true}`；`mode=rpc hasUI=true` 由探针日志直接证实 |
| 文本型子任务 | ✅ `task`＝首条 user 消息、messages＝user+assistant、`finalOutput`="OK"、`status: complete`、`truncated` 全 false、payload 无宿主路径 |
| 使用工具的子任务 | ✅ messages 依次含 `text`(task) → `toolCall`(`name: "bash"`) → `toolResult`("structured-probe") → `text`("DONE")；`finalOutput`="DONE" |
| 子节点定向 | ✅ `childId: "step:0"` → 200 且回显 childId |
| 运行中检视 | ✅ 返回 200、`status: "running"`、messages 为空（诚实空态，不挂起、不干扰运行） |
| 负例 | ✅ 未知 id → 404 `not_found`；多余字段 → 400；`lines` 非法 → 400；stale generation → 409；伪造 Origin → 403；缺令牌 → 401；响应不含宿主路径 |
| 套件 | ✅ 264 tests / 261 pass / 0 fail / 3 opt-in skip（第三个 skip 是新增的 opt-in SDK smoke），`npm run check` exit 0 |

残余（带入工作组 6）：
1. 活体 `toolCall` 的 `text` 只有 `[tool: bash]`——**没有参数预览**：pi-subagents 的 `sessionMessageParts` 只在 `entry.args !== undefined` 时附带参数，而当前 Pi 会话记录的 toolCall part 不带该字段。属上游投影限制，我们如实透传。
2. 运行中检视可能返回 0 条消息（子代理会话文件尚未落盘/可读），页面需把它渲染成正常空态而不是错误。
3. 第三个 skip 与 `PI_GUI_SMOKE_SUBAGENTS_PATH` 未设置有关，属 opt-in。

## 收尾说明（工作组 5–7）

- 工作组 5 由 designer 实现；Main 回读并做了两处裁决：结构化视图升为主按钮、`View transcript` 降为次要（fallback）；**面板重开一律取新快照**（原先复用旧答案，会让运行中的子代理看起来冻住），对应页面测试已同步更新为断言重开恰好再请求一次。
- 工作组 6 的验收证据见 evidence.md（真实 host + 真实用工具子任务 + 页面自身点击 + CDP 布局/纯文本检查）。
- 工作组 7.3 知识收口仍未执行，条目候选见 evidence.md 末节。

## 8. 从聊天行进入结构化视图

状态：已实现并经真实浏览器验收（工作组的验收记录见 evidence.md）

- [x] 8.1 `subagent` 工具结果的 `details.asyncId`（workflow 为 `runId`）投影为聊天行的 `subagentRunId`；路径字段不投影（`src/core/chat-messages.js`）。
- [x] 8.2 聊天投影把上报过的 id 交给 subagents 通道；inspect 路由接受「快照保留或聊天行上报」的 id，保留集有界（64，FIFO）且只收不透明 id 形状（`src/host/chat.js`、`src/host/host.js`、`src/host/subagents.js`、`src/core/subagents-rpc.js`）。
- [x] 8.3 聊天行渲染与 rail 相同的结构化面板（`chat:` key 空间），默认收起、点击才请求（`src/browser/app.js`、`src/browser/app.css`）。
- [x] 8.4 修复验证中发现的两个缺陷：rail 的节点注册表清理/剪枝误伤 `chat:` 面板；响应到达时 entry 已被清理则静默丢弃答案。现在 rail 只管理自己的 key 空间，迟到答案会重建 entry 并展示。
- [x] 8.5 测试：投影（含路径不外泄与负例）、保留集（形状/去重/上界/未知 id 仍 404）、页面（聊天入口默认不发请求、点击才发、rail 剪枝后仍存活）。
- [x] 8.6 真实浏览器验收：GUI 会话自己的模型调用 `subagent` 工具起真实后台子任务 → 聊天行出现入口 → 点击 = 1 次请求（`{"generation":1,"id":"…"}`）→ 面板显示 `task` / `messages` / `finalOutput`，无 markup 注入、无横向溢出。

### 知识收口结果（工作组 7.3）

按 `~/.opsx/common/knowledge-contract.md` 的日常维护流程（非候选审阅）执行，`captured`：

- 新增 pitfall：`subagent-inspect-requires-rpc-mode.md`、`widget-capture-own-bounds.md`、`periodic-rebuild-owns-its-key-space.md`（含重审条件）。
- 新增 codemap：`subagent-structured-inspect.md`。
- domain：新增术语 `referenced async id`，并修订 `fleet key` 的 Relations（区分 detail 与 inspect 的 id 来源）。
- 同步索引：`pitfalls/index.md` 7 行 = 7 个 entry、`codemap/index.md` 2 行 = 2 个 entry；自检无 orphan、无重复 active 语义、必填标题齐全。
- 未处理：`.aiknowledge/candidates/`（10 个自动候选）按契约需显式批次确认的候选审阅，本次未读取、未采纳、未删除。
