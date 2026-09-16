# Evidence：基于公开 SDK 的浏览器 GUI 会话

公共约定见 [spec.md](spec.md)，唯一任务进度见 [tasks.md](tasks.md)。

## Plan 阶段可行性验证（Main 实测）

- 宿主包解析：本仓库（`type:module`）内用裸 specifier `import("@earendil-works/pi-coding-agent")` 失败（`ERR_MODULE_NOT_FOUND`），与知识库 pitfall 一致；改用绝对路径 `file:///<globalRoot>/@earendil-works/pi-coding-agent/dist/index.js` 导入成功，导出含 `createAgentSession`、`SessionManager`、`ModelRuntime`、`SettingsManager`、`DefaultResourceLoader`。
- SDK 会话绑定（临时 session 目录，真实 agentDir，未发起模型调用）：
  - `createAgentSession({ cwd: E:/gitlab/oh-my-pi-gui, sessionManager: SessionManager.create(cwd, <temp>) })` → 成功；
  - `extensionsResult.extensions.length === 11`（用户配置的扩展已被载入，含 questionnaire/pi-subagents 等）；
  - `await session.bindExtensions({ uiContext: <stub>, mode: "print" })` → 成功，扩展随即调用我们提供的 UI context（观察到 `setStatus` 调用）；
  - `session.model` 解析为 `deepseek-flash`；`getContextUsage()` 返回 `{tokens:0, contextWindow:1000000, percent:0}`。
- 结论：新架构不需要任何私有接缝即可建立「我们提供 UI、宿主发事件」的关系；实现风险集中在 UI 契约覆盖度与 `mode` 选择（首版按 spec 用 `tui`）。

## 复用边界

上一版 change（`openspec/changes/browser-interaction-spike`，本地 Commit A = 0959a48）已验证并可直接复用的部分：`src/core/bridge-server.js`（令牌/Host/Origin/禁用端口规避+绑定后自检）、`src/core/request-store.js`（对话框请求模型与非批准语义）、`src/browser/*`（页面与增量渲染）、以及对应的传输/页面/安全测试。

## 工作组 1：Main 级发现与修复（启动期对话框死锁）

端到端验证（真实 SDK + 真实扩展 + 真实 HTTP 桥）发现一处真缺陷：实现原先在 `bindExtensions` **之后**才启动桥、并在其之后才发布 URL；而 `bindExtensions` 会等待每个 `session_start` 处理器——若处理器弹对话框（Pi 自身的项目信任/登录流程、或任意扩展的启动提示），就会出现**无人能回答的死锁**（页面还没有 URL）。

修复（Main 直接改：定位明确、改动小）：

- 桥在 `bindExtensions` **之前**启动；
- URL 在桥就绪时**立即发布**（新增 `startHost({ onReady })` 钩子，启动器打印 `Pi GUI host listening: <url>`，随后 bind 完成再打印 `Pi GUI host ready` + 会话信息）；
- 失败路径沿用既有清理：撤回 URL 文件、关闭桥、释放会话；
- 相应更新 4 个既有测试为**更强**断言（成功后发布；bind/创建失败时先发布再撤回且不报告 ready；桥绑定失败时不创建会话也不打印 URL）。

修复后同一端到端脚本完整通过：真实扩展经真实 SDK 调用 confirm/select/input/editor → 桥的 pending 中出现 → HTTP 回答后扩展收到 `true`(boolean)、`"Blue"`、`"typed-in-browser"`、`"edited-in-browser"`（类型与值均正确）；`custom` 明确失败并产生不可回答(409 `unsupported_request`)/可 dismiss(200) 的 notice；`startHost` 在对话框答完后 resolve。

套件：240 tests / 238 pass / 0 fail / 2 opt-in skip；`npm run check` 退出 0。

## 工作组 2 验收（Main 实测，真实模型）

端到端（真实 SDK 会话 + 真实 provider，临时 URL 文件，未用假会话）：

- 等 `chat.available === true` 后发送 → 200 accepted；观察到 `phase: streaming`；assistant 精确回出随机 marker（`chat-ok-...`），即真实流式链路可用。
- 第二次发送 → `POST /api/stop` 200 → 随后 `phase: idle`，停止有效。
- 未知 slash `/definitely-not-a-command-xyz` → 409 `unsupported_command`，聊天行数不变（4→4），未落给模型。
- 时序说明（有意行为，已记录）：URL 在 `bindExtensions` 之前发布，因此在 URL 出现与 chat attach 之间有一小段窗口，此时 `/api/message` 返回 503 `not_attached`、页面显示 Chat unavailable；页面文案已如实表达。

套件：257 tests / 255 pass / 0 fail / 2 opt-in skip；`npm run check` 退出 0。

## 工作组 3 验收（Main 实测，真实会话）

真实 SDK 会话 + 真实 HTTP 桥（无模型调用）：

- controls 快照：`model = {provider, id, name, reasoning, contextWindow, maxTokens}`、12 个候选（候选含 `key=provider/id`）、`thinkingLevels = [off, high, max]`、`thinkingLevel = max`；序列化结果中不含 apiKey/baseUrl/headers 等凭据字段。
- thinking 切换 `off` → 200，回显生效值 `off`，`clamped: false`。
- 模型切换 `codemaker-hub-openai/glm-5.2` → 200，回显生效模型已变为 `glm-5.2`（校正：首次探针误读 `key` 字段，当前模型 DTO 使用 `provider/id/name`）。
- 未知模型 key → 409 `model_not_allowed`；body 多余字段 → 400。
- status：cwd 正确；git 由启动瞬态 `refreshing` 稳定为 `{branch: "main", reason: null}`；`getContextUsage()` 正常。

套件：288 tests / 286 pass / 0 fail / 2 opt-in skip（连跑 3 次一致）；`npm run check` 退出 0。

## 工作组 4 验收（Main 实测，真实会话）

- 通道结论（由 worker 实证，非猜测）：pi-subagents 在扩展工厂内用 `pi.events.on("subagents:rpc:v1:request", …)` 注册 owner；该 `EventBus` 由资源加载器持有。公开会话成员没有总线（`session.extensionRunner.runtime` 无 event-bus）。采用的路线：host 用公开 `sdk.createEventBus()` 自持总线，并把它交给 `sdk.DefaultResourceLoader({ eventBus })`（保持默认发现），再用该 loader 创建会话。
- Main 真实会话验证：`/api/state` 出现 `subagents` 段，`state: ready-empty`、`available: true`（真实 pi-subagents owner 应答）；`POST /api/subagents/refresh` → 200 仍 ready-empty；未知 id → 404 `not_found`；用 fleet key 当 id → 404 `not_found`（fleet key 与 run id 分离成立）。
- 已知限制（已记录）：`PI_SUBAGENT_CHILD=1`（作为子代理运行的进程）里 pi-subagents 跳过父侧注册，面板会显示 Unavailable/超时，属如实呈现。

套件：306 tests / 303 pass / 0 fail / 3 opt-in skip；`npm run check` 退出 0。

## 真实浏览器整体验收（Chrome headless + CDP，本 change 最终集成验收）

环境：`node src/host/main.js --url-file <temp>`（真实 SDK、真实 agentDir、真实 provider），并用新增的 `PI_GUI_EXTRA_EXTENSIONS` 注入一个**临时探针扩展**（提供 `probe_dialogs`（confirm/select/input/editor/custom）与 `probe_events`（宿主 ui_prompt_start/end 观测）；探针只在系统临时目录，不在仓库内），浏览器侧用自写的 CDP 驱动（零依赖）。

| 表面 | 结果 |
|---|---|
| 加载与令牌流 | ✅ 片段 token → sessionStorage、auth 隐藏、Connected |
| 状态面板 | ✅ cwd 正确、git 稳定为 `main`、context/token 数据可见 |
| 模型与 thinking | ✅ 候选列表 + 切换并回显生效值 |
| 聊天（真实模型） | ✅ 多行发送、真实流式、精确回出随机 marker、行数稳定不重复 |
| 停止 | ✅ streaming 中停止后回到 idle |
| 未知 slash | ✅ 明确拒绝且不产生聊天行 |
| 滚动保持 | ✅ 真实布局下 streaming 时不被拉到底 |
| 标准对话框 | ✅ confirm/select/input/editor 均在**页面**回答，探针扩展收到正确值；custom 明确失败 |
| 宿主生命周期 | ✅ 宿主自产五类 `ui_prompt_start/end` 配对（confirm/select/input/editor/custom） |
| questionnaire | ✅ 新出现的 custom notice 明确 unsupported，工具调用失败、未合成为结果 |
| 子任务面板 | ✅ 空态 → 派真实后台子任务后显示 `1 fleet entry · 1 async run`；async 行 `state: running` 且有真实 `last update`；fleet 行无详情动作（key/run id 分离）；detail 为有界 tail |
| 安全拒绝 | ✅ 401/400/伪造 Origin 403/伪造 Host 403/服务器侧多余字段 400 |
| 断线重连 | ✅ 有待答问询时刷新页面 → 同一 request id 恢复，历史 27→27 不重复 |
| reload | ✅ 明确拒绝：`reload_unavailable`（「GUI 拥有自己的会话，请重启 host 进程」），同 URL/token 保持可用 |
| 退出 | ⚠️ Windows 硬杀（TerminateProcess）无法投递 SIGINT：端口已关闭（ECONNREFUSED），但 URL 文件残留；优雅退出清理由注入信号的单测覆盖，真实 Ctrl+C 路径未实测 → 记为残余 |

套件：223 tests / 221 pass / 0 fail / 2 opt-in skip；`npm run check` 退出 0；`npm run test:host` 全绿。

## 最终结论（本 change 的唯一当前结论）

**状态：实现完成 + 真实浏览器验收完成 + 两条独立审查无 blocker；残余已登记，用户决定本 change 不再修改代码，直接提交。**

- 架构：GUI 自己拥有一个 SDK 会话（`createAgentSession` + `session.bindExtensions({ uiContext, mode: "tui" })`），对话框由宿主提供的 `ExtensionUIContext` 直接落到浏览器；桥与安全层复用上一版已验证实现；旧私有接缝（`extensions/`、`src/adapter/*`、`src/core/bridge-registry.js`）已从工作树移除，共享逻辑迁入 `src/core/`（按 HEAD 逐行比对确认语义未漂移）。
- 验收：见本文件「真实浏览器整体验收」表（CDP 驱动、真实模型、真实 pi-subagents owner）。唯一未执行项是真实终端 Ctrl+C 的优雅退出。
- 审查：spec-compliance 与 release-risk 两条独立 lane 均为 **无 blocker**，公共行为约定 5/6 resolved（兼容边界一条 partially，因扩展侧会话控制落到 Pi 默认 no-op）；报出的全部 warning/证据缺口按用户决定登记为残余（清单见 tasks.md「已知残余（最终）」，不在本文件重复展开）。
- **测试数口径说明**（回应审查者关于数字不自洽的质疑）：本 change 各工作组的测试数依次为 240 → 257 → 288 → 306（随工作组增加而增长），最终一轮为 **223**——因为工作组 5 移除了旧私有接缝路线的 85 个测试（其中 19 个迁入 `test/git-status.test.js`、`test/subagents-rpc.test.js`、`test/host-sdk-loader.test.js`）。最终口径：`npm test` = **223 tests / 221 pass / 0 fail / 2 opt-in skip**；`npm run check` 退出 0；`npm run test:host` 退出 0。
- 未执行/不可复现项：真实 Ctrl+C；验收探针与 CDP 驱动不在仓库内（残余 6）；POSIX symlink 与 bun/SEA 形态无活体验证。
- Git：本 change 的全部改动（27 新增 / 27 删除 / 若干修改）提交为本地提交；不 push、不发布、不全局安装。知识收口在提交后按知识契约做有界维护（已有 4 条 pitfall / 1 条 codemap / 2 个 domain 词条）。
