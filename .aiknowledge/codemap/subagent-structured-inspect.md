# Codemap

## Purpose

说明子代理**只读检视**这条通道：浏览器如何拿到某个 subagent run（或它的子节点）的内部状态，以及它的所有权、边界与阅读顺序。回复有两种形状：async run → 结构化视图（task/messages/finalOutput）；blocking（foreground）委派 → pi-subagents 的 `status` 转写文本（`{kind:"transcript"}`），因为上游的 inspect 命令按设计拒绝前台 run。原始 artifact 文本尾部（“View transcript”）是另一条独立通道，不在此条目范围内。

## Entry points

- 页面两处入口：rail 的 async run 行与有 id 的子节点、聊天行的 `subagent` 工具结果（`src/browser/app.js` 的 `buildInspectPanel`，key 空间分别为 `run:` 与 `chat:`）。
- HTTP：`POST /api/subagents/inspect` 与 `POST /api/subagents/session`（`src/core/bridge-server.js` 的 `POST_BODY_KEYS` 精确 body allowlist 与 subagents 分支；后者只接受 generation/id/index/before）。
- 宿主与上游交互：`src/core/subagents-rpc.js` 的 `inspect()`（保留集、单飞、5s 期限）与 `subagentInspectCommand()`；接线在 `src/host/subagents.js`、`src/host/host.js`（含 `onSubagentRunIds`）。
- 载荷解析与投影：`src/core/inspect-reply.js`（`parseInspectWidgetLine` / `projectInspectReply`）；前台转写走 `SubagentsBridge.#transcriptFallback()`（同一 `status` RPC，文本经 `detailText()` 有界脱敏）。脱敏复用 `src/core/redaction.js`（`PATH_LINE` 会丢掉 `Session:`/`Transcript:`/`Output:` 这类指向宿主位置的字段行）。
- 捕获端：`src/host/ui-context.js` 的 widget capture（inspect 键专用上限）。
- 会话侧来源：`src/core/chat-messages.js` 的 `subagentRunId()`（投影 `details.asyncId` 与 `details.runId`——后者不只是 workflow：前台 single/parallel/chain 执行器也用它，这正是前台 id 进入检视入口的原因）。
- 前台 child session 读盘：`src/core/subagent-session.js`（按 Pi 的 `<parent session dir>/<parent session id>/<runId>/run-<index>/session.jsonl` 布局派生路径、lstat 拒绝符号链接、有界 tail/paging、复用 `serializeMessage` 投影 thinking/tool blocks）；接线在 `src/host/subagents.js`。

## Boundaries

宿主是唯一 writer：页面只能请求，不能命名任意 id——接受的 id 必须来自「当前 generation 成功 status 保留的 async run」或「聊天行上报过的 id」（有界 64 条 FIFO、只收不透明形状）；其余一律 `not_found`，fleet key 永不接受。上游不保证回复不含宿主路径，我们做二次有界投影与脱敏（前台转写的 `Transcript:`/`Saved output:` 字段行必须丢掉，普通文本里的路径保留）。inspect 通过 `session.prompt()` 执行扩展命令（不产生模型回合、不写聊天历史），不经过聊天桥。前台转写成功后，页面再请求 child-session page；宿主从自己的 parent `.jsonl` 文件派生路径，不接受页面路径，拒绝符号链接/非 regular file，尾部最多 8 MiB、最多保留 2000 条、每页 40 条，游标只向旧页走。面板只读，不提供 steer/resume/stop。

## Read next

`src/core/subagents-rpc.js`（保留集与超时语义）→ `src/core/inspect-reply.js`（解析/投影）→ `src/host/ui-context.js`（捕获）→ `src/core/subagent-session.js`（实际 child 文件布局与有界读盘）→ `src/host/subagents.js`（代入 generation/allowlist）→ `src/browser/app.js`（两处入口与 key 空间）→ 测试 `test/subagents-rpc.test.js`、`test/inspect-reply.test.js`、`test/subagent-session.test.js`、`test/subagents-page.test.js`、`test/host-subagents-server.test.js`；上游契约与兼容代价见提交 `17104e4`（宿主侧）与 `d10355d`（聊天行入口）中的 change 文档（spec/tasks/evidence，已随该 change 收口从工作树移除）。
