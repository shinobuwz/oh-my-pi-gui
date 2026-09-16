# Tasks：基于公开 SDK 的浏览器 GUI 会话

公共约定见 [spec.md](spec.md)，重要探索与验收结论见 [evidence.md](evidence.md)。本文件是唯一任务进度来源，由 Main 核对实际结果后更新。

可复用基线：上一版 change（`openspec/changes/browser-interaction-spike`，Commit A = 0959a48）已交付并活体验收通过的传输层、请求模型、页面与安全硬化，本 change 直接复用，不重复实现。

## 1. SDK 会话引导与 UI context 桥接

状态：实现级闭合（Main 已回读 src/host/*、跑通 240 tests 并做过真实 SDK + 真实扩展 + HTTP 桥的端到端对话框验证；启动期对话框死锁已由 Main 修复，见 evidence.md）。真实浏览器页面侧验收待与工作组 2 一起做。

依赖：Pi 0.85.1 公开 SDK（`createAgentSession`、`AgentSession.bindExtensions`、`ExtensionUIContext`）；Node 24 内置能力。
导航：`dist/core/sdk.d.ts`（CreateAgentSessionOptions / createAgentSession）、`dist/core/agent-session.d.ts`（ExtensionBindings.uiContext、bindExtensions、setModel、setThinkingLevel、getContextUsage、sessionManager、subscribe）、`dist/core/extensions/types.d.ts`（ExtensionUIContext 契约）、现有 `src/core/bridge-server.js` 与 `src/core/request-store.js`。

- [x] 1.1 实现 host 进程骨架：创建 SDK 会话（沿用用户 agentDir/settings/模型认证，cwd 可配置）、绑定 UI context、启动 loopback 桥并发布 URL；失败时明确报错且不降级终端。
- [x] 1.2 实现浏览器驱动的 `ExtensionUIContext`：confirm/select/input/editor 落到浏览器并遵守原返回类型；custom 明确 unsupported；notify/status 等非阻塞能力按最小实现处理并如实标注。
- [x] 1.3 验证并保住宿主自产的 `ui_prompt_start`/`ui_prompt_end` 生命周期（含并发/嵌套），不得自造事件；对比上一版已通过的语义。
- [x] 1.4 非批准语义与边界：超时、取消、断线、重复/过期回答失败且不执行；跨会话/跨进程不共享批准。
- [x] 1.5 启动器 UX：独立命令一条启动、默认新建会话（写入正常会话目录）；URL 文件与终端提示；宿主包按绝对路径解析（env → 全局 npm 位置 → `npm root -g`）；不修改用户配置。
- [x] 1.6 `bindExtensions` 使用 `mode: "tui"`（使交互型扩展启用），并确认 `custom` 仍被明确标记 unsupported。

### Scenario：原流程继续

- **WHEN** 会话内扩展调用 confirm/select/input/editor
- **THEN** 浏览器展示原始标题与内容，用户提交后原调用收到符合契约的返回值并继续
- **AND** 宿主观察者按原本并发/嵌套语义收到 ui_prompt_start/end

### Scenario：拒绝无效访问

- **WHEN** 缺少/错误令牌、Host/Origin 不合法、回答与当前请求不匹配或超出限制
- **THEN** 服务器拒绝，不解析为批准，不调用任意宿主方法
- **AND** 问题中的 HTML/脚本以文本显示，不执行

### Scenario：会话失败与端口边界

- **WHEN** SDK 入口缺失/形状不符、会话创建失败、绑定端口不可用或客户端自检失败
- **THEN** 明确报错并拒绝启动（fail-closed），不发布打不开的 URL，不静默转入终端交互

## 2. 聊天、停止与交付语义

状态：实现级闭合 + Main 真实模型端到端验证通过（流式、停止、slash 拒绝；详见 evidence.md）。

依赖：工作组 1 的会话与桥。
导航：`AgentSession.prompt/abort/subscribe`、`PromptOptions.streamingBehavior`、`sessionManager`、上一版的 `src/adapter/chat-bridge.js`（改用 SDK 事件源）与 `src/browser/app.js` 的增量渲染（revision/since）。

- [x] 2.1 聊天闭环：多行发送、真实流式、停止（abort）、历史与当前分支、刷新不重复、浏览历史不强制滚动。
- [x] 2.2 交付语义：流式中区分 steer/follow-up 并明确「已接受≠已执行」；idle 下非 normal 归一化并回显；未知/不适用命令明确拒绝。
- [x] 2.3 thinking/工具输出折叠与敏感 key 脱敏，未知 provider blocks 不输出。
- [x] 2.4 增量状态协议沿用上一版（每消息 revision + since + historyIds），并保持向后兼容的整包语义。

## 3. 模型、thinking 与状态

状态：实现级闭合 + Main 真实会话端到端验证（模型/thinking 切换回显、状态面板；无凭据泄露；详见 evidence.md）。

依赖：工作组 1。
导航：`setModel/setThinkingLevel`（含 ModelMutationOptions.persist 默认）、`getContextUsage()`、`sessionManager`、上一版 `src/adapter/model-bridge.js` 与 `status-bridge.js`。

- [x] 3.1 模型与 thinking 切换并回显宿主实际生效值；候选遵循 scopedModels（空则用可用模型）；不暴露凭据、不写默认配置。
- [x] 3.2 状态面板：cwd、Git 分支（只读查询）、上下文用量；缺失标未知而不是 0。

## 4. 子任务只读可视化

状态：实现级闭合 + Main 真实会话验证（ready-empty、refresh、fleet key/run id 分离；详见 evidence.md）。带真实 async run 行的展示留到最终浏览器验收。

依赖：工作组 1/2。
导航：pi-subagents 公开 RPC/事件（上一版 `src/adapter/subagents-bridge.js` 已实现消费侧）、SDK 会话的资源加载路径。

- [x] 4.1 实测 pi-subagents 是否随 SDK 会话资源载入、其进程内 RPC 是否可用；不可用则如实显示不可用。
- [x] 4.2 只读列表与按需详情（有界 tail）、fleet key 与 run id 分离、失败/超时/空态区分；不提供新建/管理/调度入口。

## 5. 传输层复用、安全与会话生命周期

状态：实现级闭合；旧私有接缝（extensions/ + src/adapter/ + 死代码 registry）已从工作树移除，共享逻辑迁入 `src/core/`，语义按 HEAD 逐行比对确认不变；README/脚本/.aiknowledge 同步。

依赖：工作组 1。
导航：现有 `src/core/bridge-server.js`（令牌/Host/Origin/禁用端口+自检）、`src/core/request-store.js`、`src/browser/*`。

- [x] 5.1 复用并核对传输层：令牌、Host/Origin/Sec-Fetch-Site、精确 body key allowlist、禁用端口规避与绑定后自检全部保留并通过测试。
- [x] 5.2 会话生命周期：GUI 进程退出即释放资源（服务器、令牌、URL 文件、会话句柄）；不做跨进程恢复；如需会话重建，走 SDK 的 runtime 层并明确语义。
- [x] 5.3 停用旧私有接缝路径：`runner-capture`/`ui-adapter`/宿主包捕获与 reload 跟踪不再进入启动路径；保留文件需在 README 标注为 legacy 或删除。

### Scenario：资源与边界

- **WHEN** GUI 进程收到退出（正常或异常）
- **THEN** 释放 loopback 服务器、令牌、URL 文件与会话；不留下仍可访问的端口或凭据
- **AND** 浏览器断开本身不结束会话；重新打开页面可重连并恢复展示

## 最终审查与交付

真实浏览器（CDP 驱动）验收已完成，覆盖：loading/状态/模型/聊天与流式/停止/slash/滚动/标准对话框/宿主生命周期/questionnaire 不支持/子任务（含真实 async run 行）/安全拒绝/断线重连/reload 明确拒绝。**未执行**的手工项：真实终端 Ctrl+C 的优雅退出与 URL 文件删除（本机只能硬杀，仅观察到端口关闭）；后者对应场景的自动断言用的是注入信号。

- [x] 实现闭合后，两个独立只读 reviewer 分别审查 spec-compliance 与 release-risk（均为同角色 fallback，已标注）。结论：**无 blocker**，但报出 6 类 warning/证据缺口，**用户决定本 change 不修代码，全部登记为残余**（见下）。
- [x] 运行 npm test 与 npm run check 完整套件；执行真实 SDK 会话 + 真实浏览器验收。**口径修正**：验收的浏览器侧完成（见 evidence.md 验收表），但**退出清理未在真实终端验证**（硬杀无法投递 SIGINT；优雅清理由注入信号的单测覆盖），也不包含真实终端手动步骤。
- [x] Main 将唯一当前结论写 evidence；未验证或受阻不标通过（本 change 结论为「实现与浏览器验收完成、残余已登记」）。已创建本地提交；不 push、不发布、不全局安装。

## 已知残余（最终，来自两条独立审查；按用户决定不改代码）

1. **扩展侧会话控制成员未绑定**：`ctx.newSession/fork/navigateTree/switchSession/reload/waitForIdle/shutdown` 落到 Pi 默认 no-op，且 `newSession/fork/navigateTree/switchSession` 返回「成功形状」`{cancelled:false}` → 扩展可能宣告已完成而实际未发生（risk W1）。host 自己的 `/api/reload` 明确 501。
2. **启动窗口存活**：从 URL 发布到 `bindExtensions` 结束之间无 keep-alive、无信号处理器；若有扩展在 `session_start` 弹阻塞对话框，进程可能静默退出（URL 文件残留、无报错）。未复现（spec W1，高）。
3. **自检 inconclusive 仍发布 URL**：非端口类自检失败只在 host stderr 记一行，未在用户可见面标注（两 lane）。
4. **退出路径**：真实 Ctrl+C 未验证；`main.js` 不在优雅关闭后强制 `process.exit()`；宿主退出时后台子任务进程的归宿未处理（risk W3）。
5. **聊天文本未做密钥形态脱敏**：工具输出/错误文本只截断不脱敏，与子任务面板不一致（risk W5）。
6. **验收工件未入库**：探针扩展与 CDP 驱动不在仓库内，最强结论不可独立复跑（risk W6）。`PI_GUI_EXTRA_EXTENSIONS` 已在 README 文档化但无单测。
7. 其他低/信息级：Windows 下 URL 文件 `0o600` 不生效（依赖目录 ACL）；`ui-context` 自省成员与 UI 能力同对象（扩展可自伤式 `deactivate`）；`select` 候选 >200 时只能 cancel；页面仍渲染必然被拒的 Reload 按钮；`session_start` 内调用 `custom` 会导致启动失败（unsupported 语义的副作用）；无测试断言宿主不写用户配置（与 `pi` 自身启动同路径，属声明）。

## 复用与处置计划

- 直接复用：`src/core/bridge-server.js`、`src/core/request-store.js`、`src/browser/*`、以及 `test/bridge-server.test.js`、`test/browser-page.test.js`、`test/browser-bridge.test.js` 中与传输/安全/页面相关的用例。
- 改造：`chat/model/status/subagents` 适配层的数据源从「宿主 ctx/pi + 事件」改为「SDK session + subscribe 事件」。
- 停用：`src/adapter/runner-capture.js`、`src/adapter/ui-adapter.js`、`src/adapter/host-package.js` 的捕获相关部分与 `src/adapter/browser-bridge.js` 的宿主绑定/代际机制。
