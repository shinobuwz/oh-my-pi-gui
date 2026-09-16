# Codemap

## Purpose

说明浏览器 GUI 与 Pi 会话之间的绑定点：对话框、事件流与状态数据分别从哪里来。

## Entry points

- 公开 SDK（当前路线）：`createAgentSession()`（`dist/core/sdk.d.ts`）→ `session.bindExtensions({ uiContext, mode })`（`dist/core/agent-session.d.ts` 的 `ExtensionBindings`）。当前 `src/host/*` 实现这条路线（`openspec/changes/browser-gui-sdk`，工作组 1–5 已实现）。
- 旧私有接缝实现（已被否选，并已从工作树删除；代码保留在 git 历史/上一 change 的 Commit A = `0959a48`，仅作对照）：`extensions/browser-interaction/index.js`、`src/adapter/runner-capture.js`、`src/adapter/ui-adapter.js`。
- 传输与页面（两条路线共用，仍是当前实现）：`src/core/bridge-server.js`、`src/core/request-store.js`、`src/browser/app.js`、`src/browser/index.html`。
- 共享纯逻辑（当前实现）：`src/core/chat-messages.js`、`src/core/model-catalog.js`、`src/core/git-status.js`、`src/core/subagents-rpc.js`。

## Boundaries

`bridge-server` 只负责 loopback HTTP、静态资源与令牌/Host/Origin 校验；UI 语义由 `ExtensionUIContext` 契约定义；页面永不接触宿主凭据、session 文件或任意方法调用。

## Read next

`src/core/request-store.js`（非批准语义与超时）、`test/host-session.test.js`、`test/host-ui-context.test.js`、`test/bridge-server.test.js`、`openspec/changes/browser-interaction-spike/evidence.md`（私有接缝路线的架构决策与残余，历史）。
