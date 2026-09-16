# Codemap

## Purpose

说明子代理**结构化检视**这条通道：浏览器如何拿到某个 async run（或它的子节点）的会话内容，以及它的所有权、边界与阅读顺序。原始 artifact 文本尾部（“View transcript”）是另一条独立通道，不在此条目范围内。

## Entry points

- 页面两处入口：rail 的 async run 行与有 id 的子节点、聊天行的 `subagent` 工具结果（`src/browser/app.js` 的 `buildInspectPanel`，key 空间分别为 `run:` 与 `chat:`）。
- HTTP：`POST /api/subagents/inspect`（`src/core/bridge-server.js` 的 `POST_BODY_KEYS` 精确 body allowlist 与 subagents 分支）。
- 宿主与上游交互：`src/core/subagents-rpc.js` 的 `inspect()`（保留集、单飞、5s 期限）与 `subagentInspectCommand()`；接线在 `src/host/subagents.js`、`src/host/host.js`（含 `onSubagentRunIds`）。
- 载荷解析与投影：`src/core/inspect-reply.js`（`parseInspectWidgetLine` / `projectInspectReply`）；脱敏复用 `src/core/redaction.js`。
- 捕获端：`src/host/ui-context.js` 的 widget capture（inspect 键专用上限）。
- 会话侧来源：`src/core/chat-messages.js` 的 `subagentRunId()`（只投影 `details.asyncId` / workflow 的 `runId`）。

## Boundaries

宿主是唯一 writer：页面只能请求，不能命名任意 id——接受的 id 必须来自「当前 generation 成功 status 保留的 async run」或「聊天行上报过的 id」（有界 64 条 FIFO、只收不透明形状）；其余一律 `not_found`，fleet key 永不接受。上游保证回复不含文件路径，我们仍做二次有界投影与脱敏。inspect 通过 `session.prompt()` 执行扩展命令（不产生模型回合、不写聊天历史），不经过聊天桥。面板只读，不提供 steer/resume/stop。

## Read next

`src/core/subagents-rpc.js`（保留集与超时语义）→ `src/core/inspect-reply.js`（解析/投影）→ `src/host/ui-context.js`（捕获）→ `src/browser/app.js`（两处入口与 key 空间）→ 测试 `test/subagents-rpc.test.js`、`test/inspect-reply.test.js`、`test/subagents-page.test.js`、`test/host-chat.test.js`；上游契约与兼容代价见提交 `17104e4`（宿主侧）与 `d10355d`（聊天行入口）中的 change 文档（spec/tasks/evidence，已随该 change 收口从工作树移除）。
