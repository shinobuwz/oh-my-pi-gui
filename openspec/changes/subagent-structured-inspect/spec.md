# Spec：子代理结构化检视（宿主 inspect 通道）

## 问题与目标

现状：subagents 面板只有 fleet/async 摘要 + 一个 run 级「View transcript」。后者是 `status { view: "transcript", lines: 80 }`，扩展回的是该 run **磁盘 activity artifact 的文本尾部**，不是子代理内部的对话/工具调用结构。

已核实（pi-subagents 0.67.0）：扩展已提供**专门给宿主的结构化检视协议**——命令 `/subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]`，回 `pi-subagents.inspect-reply`：

- `messages[]: { role, kind: "text" | "toolCall" | "toolResult", text, name?, isError? }`（数据源是子代理自己的 Pi 会话文件，由扩展解析成 parts；工具调用带参数 JSON 预览、工具结果带结果预览与失败标记）
- `task`（child 首条 user 消息）、`finalOutput`、`status`、`label`、`truncated { task, messages, finalOutput }`
- 有界：消息默认 100 / 最多 200 条、单条 1000 字、`task` 2000、`finalOutput` 8000、序列化总 64KB；超限**从最老的消息开始丢**并标记
- 不含任何文件路径；按 session 归属校验（`foreign_session` / `not_found` / `stale` / `no_active_session`）

堵点只有一处：该命令 handler 在 `ctx.mode === "tui"` 时拒绝发出（`slash-commands.ts:932`），而宿主当前 `HOST_UI_MODE = "tui"`。

用户已裁决：**走宿主侧路线（不先等上游）**——`bindExtensions` 改绑 `mode: "rpc"`，接受 `ctx.mode !== "tui"` 的扩展降级代价，把结构化检视接进页面。

## 范围与非目标

- 范围：宿主绑定模式切换；宿主调 inspect 命令并截获结构化回复；我们自己的有界投影与脱敏；新增只读 HTTP 路由；页面为每个 async run / 可定位子节点提供结构化视图；文档与测试同步。
- 非目标：不 hook pi-subagents 内部模块、不改上游包；不新增 steer/resume/stop 等控制动作（面板仍只读）；不新增任意文件读取或任意方法调用；不承诺 thinking 原文与工具参数/结果**全文**（扩展 payload 里没有，单条 1000 字截断）。

## 公共行为约定

### 绑定模式与兼容

- `session.bindExtensions({ uiContext, mode: "rpc" })`；其余绑定参数不变。
- 已知并接受的降级：`ctx.mode !== "tui"` 的扩展不再按 tui 语义工作——本地 `questionnaire.ts:93` 会直接返回 “UI not available (running in non-interactive mode)”，Pi 自带 llama 扩展走非 tui 分支。宿主必须如实呈现这类失败文案，不挂起、不傀儡化。
- 对话框能力不变：`confirm` / `select` / `input` / `editor` 仍通过我们的 UI context 落到浏览器（Pi 契约中 rpc 与 tui 同样具备对话框能力；`hasUI()` 只取决于是否提供 uiContext）。
- 宿主包入口形状不符时仍 fail-closed。

### inspect 契约（宿主 → 扩展）

- 宿主用 `session.prompt("/subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]")` 触发。该命令由 `prompt()` 立即执行、**不产生模型回合、不写入会话历史**（已核实 `agent-session.js:826-834`）。
- `requestId` 由宿主生成，形如 `^[A-Za-z0-9_-]{1,64}$`；`asyncId` 只接受**当前 generation 成功 status 中保留过的 async run id**；`childId` 只接受该 run 快照里出现过的节点 id（fleet key 永不接受，且无 id 的子节点不得发起 inspect）。
- 宿主在 `prompt()` 返回后，从 UI context 截获 `subagent-inspect` 键的 `PI_SUBAGENT_INSPECT_JSON:` 载荷，按 `requestId` 关联；不匹配、过期或畸形的回复一律丢弃（不当作有效数据）。
- 单次 inspect 有超时上限（默认 5s）与并发上限（同 generation 内 1 个在飞）；超时/失败返回明确结果，不重试风暴、不与聊天/流式互相干扰（扩展命令允许在 streaming 中执行，本功能不得打断正在进行的回合）。

### 页面 API

- 新路由 `POST /api/subagents/inspect`，body 精确 allowlist `{ generation, id, childId?, lines? }`；沿用既有语义：`stale_generation`(409) / `invalid_body`(400) / `not_found`(404)。
- 响应是**我们自己的有界投影**（不信任扩展侧边界，二次截断）：`messages[]` 只保留 `role` / `kind` / `name` / `isError` / `text`（单条 ≤1000 字，条数 ≤200），以及 `task`（≤2000）、`finalOutput`（≤8000）、`truncated`、`status`、`label`。
- **响应不含任何文件路径**；凭证式文本仍走既有脱敏（api key/token/Bearer/敏感路径字段），错误文案不得回显宿主路径。
- 扩展错误码如实映射：`not_found`(404) / `foreign_session`(403) / `stale`(409) / `no_active_session`(503) / `invalid_request`(400) / `internal`(502)；未知码归一化为 `inspect_failed`(502)，并保留有界 message。
- 只读、无副作用：不写会话、不改 run 状态、不触发模型调用。

### 页面行为

- 每个 async run 提供「结构化视图」动作，展开后的可定位子节点也能单独请求；**默认不发请求**，点击才请求。
- 渲染只用 `textContent` 与 DOM 构造（沿用 no-innerHTML 与静态模板约束）；`toolCall` / `toolResult` 复用现有 chat 块的视觉语言（名称、参数预览、失败标记）。
- `truncated.messages > 0` 必须显式提示「更早的消息已被丢弃」；`task` / `finalOutput` 缺失时标未知，不伪造。
- 现有「View transcript」（artifact 文本尾部）保留：它与结构视图语义不同，且在结构化不可用时（例如 session 文件不可读、artifact 仍在）是退路。
- 错误、超时、`foreign_session` 等都以明确文案呈现，不显示伪造数据。

### 聊天行入口（本 change 的第二段交付）

- `subagent` 工具结果在 Pi 会话里带 `details.asyncId`（workflow 为 `runId`），宿主把它作为**唯一**的
  run 身份投影进聊天行（`subagentRunId`）；`details.asyncDir` 等路径字段**永不**投影，浏览器只拿到 id。
- 聊天行据此提供与 rail 相同的结构化视图（默认收起、点击才请求）。聊天面板使用独立的 key 空间
  （`chat:`），与 rail 的 `run:` 互不干扰。
- 该 id 让 inspect 路由接受它：宿主把投影出的 id 记入一个有界（64 条 FIFO）、只接受不透明 id 形状的
  保留集，`/api/subagents/inspect` 同时接受「状态快照保留的 id」与「聊天行上报过的 id」；其余 id 仍是
  `not_found`，fleet key 永不接受。
- 已完成、已离开有界状态快照的 run 依然能从聊天行检视；rail 的定期重建与剪枝只作用于 `run:` 空间，
  不得删除聊天面板的状态；响应到达时若面板状态已被清理，必须重建并展示结果，**不得静默丢弃**。

### 安全边界

- 新路由同样受随机令牌 / Host / Origin / Sec-Fetch-Site / 精确 body 校验；不新增任意路径读取与任意方法调用。
- 宿主不因 inspect 向会话注入任何聊天内容；页面拿到的文本一律按纯文本渲染。

## 验收（可观察）

1. 真实会话 + 真实子任务：对已完成的 async run 请求结构化视图 → 页面显示 `messages`（至少一条 `toolCall` 与一条 `toolResult`，失败时带 `isError`）、`task`、`finalOutput`，触发上限时显示截断提示。
2. `foreign_session`（run 属于其它 session）→ 明确错误，不显示伪造数据。
3. mode 改 rpc 的回归面：`confirm`/`select`/`input`/`editor` 仍在浏览器回答；`questionnaire` 明确降级且不挂起（文案如实）。
4. 安全：新路由 401（缺令牌）/403（伪造 Origin/Host）/400（多余字段）全部拒绝；响应中无路径、无凭据。
5. `npm test` 与 `npm run check` 全绿（基线 223 tests / 221 pass / 0 fail / 2 skip）。
