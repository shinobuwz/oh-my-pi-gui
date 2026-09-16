# Spec：基于公开 SDK 的浏览器 GUI 会话

## 问题与目标

上一版原型（`openspec/changes/browser-interaction-spike`）把浏览器接到「当前正在跑的 TUI 会话」的对话框上，必须 hook Pi 的私有 UI 接缝，导致一连串脆弱依赖（捕获 `ExtensionRunner`、bundle/dist 类身份、宿主 reload 跟踪、仓库内裸 specifier 解析等）。

用户已明确：**GUI 启动后是否与 TUI 是同一个会话并不重要，重点是日常使用都在 GUI 里**。因此本 change 用 Pi 的**公开 SDK**重建：

- 用户在终端启动一次（一条命令），该进程用 `createAgentSession()` 建立一个 agent 会话，并通过 `session.bindExtensions({ uiContext })` 把它自己的 UI context 接到浏览器；
- 此后聊天、对话框、模型/thinking、状态、子任务、停止与继续全部在浏览器完成，不要求回终端；
- 不再 hook 任何私有接缝。

## 范围与非目标

- 在仓库内实现一个 GUI host 进程（Node，ESM）：SDK 会话 + 现有 loopback 桥 + 现有浏览器页面。
- 浏览器侧：标准对话框、最小聊天（流式/停止/steer/follow-up）、模型与 thinking、cwd/Git/用量、pi-subagents 只读列表与详情、断线重连、明确 unsupported 的 custom/questionnaire。
- 复用上一版已验证的传输与安全层：`src/core/bridge-server.js`（含禁用端口规避与绑定后自检）、`src/core/request-store.js`、`src/browser/*`、以及相关测试。
- 非目标：附着到用户已有的 TUI 会话；工作区/文件管理/多会话/Web IDE；provider 与凭据编辑；修改宿主安装、用户配置或授权策略；发布或全局安装；跨进程自动恢复。
- 首版不承诺：与 TUI 会话共享历史；把 TUI 里发起的对话框转到浏览器。

## 公共行为约定

### 启动与会话

- 启动器在终端运行一次（独立命令，例如 `npm start` 或 `node ./src/host/main.js`），接受 cwd 与可选参数；它不得修改用户 settings/凭据，也不写全局配置。
- 会话通过 `createAgentSession()` 创建：沿用用户 `agentDir`/settings 与模型认证；`persist` 语义保持默认（不改默认配置）。
- **默认每次启动新建会话**（写入正常会话目录，便于之后用 `pi -c` 延续），首版不提供延续开关。
- 宿主包按解析出的安装路径**以绝对路径导入**（见知识库 pitfall「本仓库内不要用裸 specifier 导入宿主包」）：解析顺序为显式 env → 全局 npm 安装位置 → `npm root -g`；解析失败明确报错。
- `bindExtensions` 使用 `mode: "tui"`，使要求交互模式的扩展（如 questionnaire）被启用；`custom` 仍由我们明确标记 unsupported。
- 启动成功后打印并提供 URL（写 URL 文件 + 终端提示），token 只经 URL 片段传递；失败时明确报错，不静默降级到终端交互。
- 会话所有权归 GUI 进程：GUI 退出即结束该会话；不得读写其它 Pi 进程的 session 文件来「附着」。

### 对话框与授权

- 宿主扩展的 `confirm`/`select`/`input`/`editor` 通过我们提供的 `ExtensionUIContext` 落到浏览器；返回值类型与 Pi 的原契约一致（confirm → boolean，其余 → string/undefined）。
- 授权的同意与拒绝不可合并；超时、取消、断线、重复或过期回答一律以**非批准**结果结束，且不得再次执行原流程。
- 宿主的 `ui_prompt_start`/`ui_prompt_end` 生命周期必须保持由宿主发出（因为 runner 会包装我们提供的 UI context）；不得自造事件。
- `custom`（含 questionnaire）首版明确 unsupported：浏览器可见、原调用明确失败、不挂起、不傀儡化答案。

### 聊天、模型与状态

- 发送走 `session.prompt(text, options)`；流式与工具输出通过 `session.subscribe()` 事件呈现；停止走 `session.abort()`。
- 流式中发送时区分 steer / follow-up，并明确「已接受」不等于「已执行」；未知或不适用的 slash 命令不得偷偷当普通提示发送。
- 模型与 thinking 走 `session.setModel()` / `session.setThinkingLevel()`，回显宿主实际生效值（thinking 以钳制后的值为准），不发送 provider 凭据、不写默认配置。
- cwd/Git/用量取自公开数据（session manager / `getContextUsage()` / 只读 Git 查询）；缺失标未知，不伪造 0 值。

### 子任务

- pi-subagents 作为扩展随会话资源载入；只读列表与详情沿用公开 RPC/事件，不新建调度器、不管理 agent 配置。
- fleet key 与 run id 分离；详情只针对可定位的 run；RPC 不可用、超时或无任务都有明确状态，不造数据。

### 本地安全

- 沿用现有加固：仅绑定 127.0.0.1、随机不可预测令牌、精确 Host/Origin/Sec-Fetch-Site 校验、按路由的精确 body key allowlist、资源本地提供、不执行模型/工具输出的 HTML/脚本、不提供任意文件读取或任意方法调用 API。
- 绑定端口必须避开客户端（undici/浏览器）禁用端口，并在发布 URL 前完成带超时的客户端自检；自检失败必须 fail-closed 或明确标注不可用，不得发布打不开的 URL。

### 兼容边界

- 只依赖公开 API：`createAgentSession`、`AgentSession`（prompt/abort/subscribe/setModel/setThinkingLevel/getContextUsage/sessionManager）、`ExtensionUIContext`、`session.bindExtensions`、以及 pi-subagents 的公开 RPC。
- 版本变化导致入口缺失或形状不符时，明确拒绝启动并给出原因（沿用 fail-closed 风格），不做静默降级。
- 已实测（Plan 阶段，见 evidence.md）：按绝对路径导入 SDK 入口可用；`createAgentSession` 能载入用户全部扩展（11 个）并 `bindExtensions({ uiContext })` 成功，扩展随即调用我们的 UI context。

## 整体方案与关键决策

- 复用：`bridge-server`（HTTP/令牌/静态资源/禁用端口规避）、`request-store`（对话框请求模型）、`src/browser/*`（页面与渲染）、聊天/状态/子任务面板的呈现与测试。
- 新增：`src/host/`（SDK 会话引导、UI context 实现、事件到桥的适配、会话生命周期命令）。
- 移除/停用：`runner-capture`、`ui-adapter` 的私有接缝路径、宿主包捕获兼容检查、宿主 reload 跟踪与代际机制（GUI 自己拥有会话进程，重启即重启）。
- 关键决策：UI context 由我们提供而非捕获；宿主生命周期事件仍由宿主发出；GUI 会话独立于任何 TUI 会话（用户已确认可接受）。

## 风险与验证边界

- SDK 与 `ExtensionUIContext` 契约在 Pi 升级后可能变化 —— 以入口/形状检查 + 明确失败应对，并用真实启动验证。
- pi-subagents 在 SDK 会话中是否可用（会话资源加载器是否载入该扩展、其 RPC 是否可在进程内 ping/status）需要实测确认；若不可用，子任务面板必须如实显示不可用而不是造数据。
- 对话框的并发/嵌套语义需以真实扩展验证（复用现有 consumer/observer fixture 思路，但改为通过 SDK 会话驱动）。
- 真实浏览器验收不可省：fake DOM/HTTP 测试只作局部证据。

## 整体验收标准

1. 一条终端命令启动后，浏览器可完成：多行聊天（含流式与停止）、模型/thinking 切换并回显生效值、标准授权确认与拒绝、questionnaire 明确不支持、子任务列表与详情、刷新/断线重连、以及明确 unsupported 的 custom 提示。
2. 启动失败、端口不可用、SDK 入口缺失等情形都有明确错误，不静默降级到终端交互、不发布不可用 URL。
3. 安全约定全部保持（令牌、Host/Origin、精确 body key、无任意方法调用、无凭据泄露）。
4. 证据包含：局部行为测试、真实 SDK 会话 + 真实浏览器验收、以及独立只读审查；未覆盖项如实登记，不标通过。
