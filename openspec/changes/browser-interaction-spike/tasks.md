# Tasks：当前活 Pi session 的轻量浏览器 MVP

公共约定见 [spec.md](spec.md)，重要探索和验收结论见 [evidence.md](evidence.md)。本文件是唯一任务进度来源，由 Main 核对实际结果后更新。

## 1. 标准扩展问询的浏览器闭环

依赖：已批准版本限定的内部 UI 接缝；本地 Node 24.16.0 / npm 11.13.0，仓库初始无源码。导航：安装 Pi 的 docs/extensions.md（尤其长寿命资源、UI 生命周期、mode、对话框）、docs/tui.md、examples/extensions/timed-confirm.ts；dist/core/extensions/runner.js setUIContext/createContext、dist/core/agent-session.js bindExtensions、交互模式绑定调用方。

- [x] 1.1 实现本仓库内可显式加载的最小 extension、兼容检查及标准问询桥接；不修改宿主安装与配置。
- [x] 1.2 实现本地问询页和有认证的 loopback 传输；浏览器回答、取消、断线重连与错误状态可观察（实现与 HTTP 消费者局部验证，真实浏览器见最终集成）。
- [x] 1.3 添加实际行为测试和最小运行说明；按实际阶段标明未完成/未验证，不发明已发布包名。测试与实现优先采用 Node 内置能力，避免重型构建链。
- [x] 1.4 修复 ui_prompt_start/end 被绕过的根因，使用宿主原有生命周期包装，验证等待/结束与并发合并语义；不得手工 emit 伪造宿主事件。
- [x] 1.5 实现浏览器发起 reload 与同进程入口/认证连续性，新代际拒绝旧回答，真实 shutdown 清理资源；已通过模拟宿主生命周期的局部验证。实际 Pi 完整 reload、活子任务通知与浏览器最终集成尚未验证，见最终审查与交付，不能由本勾选推断最终通过。

### Scenario：原流程继续

- **WHEN** 同一个活 Pi session 内其他扩展调用 confirm/select/input/editor
- **THEN** 浏览器展示原始标题、问题/选项/预填内容，并由用户提交选择或文字
- **AND** 原调用收到符合原方法契约的返回值并继续，不要求终端操作；宿主观察者按原本的并发/嵌套语义收到 ui_prompt_start/end。

### Scenario：取消、断线与重连

- **WHEN** 浏览器在等待回答时断线并重连
- **THEN** 未过期请求保留同一 ID 并重新展示，不自动批准、不转终端
- **AND** 显式取消、消费者超时或 abort 返回非批准结果，失效 ID 和重复回答不再次执行。

### Scenario：拒绝无效访问

- **WHEN** 访问缺少/错误令牌、Host 或 Origin 不合法、回答内容与当前请求不匹配或超出限制
- **THEN** 服务器拒绝请求，不解析为批准，不调用任意宿主方法
- **AND** 问题中的 HTML/脚本以文本显示，不执行。

### Scenario：兼容与资源边界

- **WHEN** 版本或 UI 接缝自检不匹配，或宿主 reload/shutdown
- **THEN** 不匹配时不启用半可用 GUI；关闭时清理本实例资源、作废旧回答
- **AND** 浏览器断开本身不触发宿主 session 关闭。

### Scenario：浏览器 reload 闭环

- **WHEN** 用户从浏览器发起当前宿主的 reload（包括存在待答问询的情况）
- **THEN** 旧代际请求安全结束，新绑定完成后同一页面自动恢复，不取新地址、不重新输入令牌、不回终端
- **AND** reload 期间操作明确拒绝/提示重载；旧请求回答拒绝，不保留旧 ctx，不丢失仍属当前宿主的子任务完成通知。

### 验证与完成条件

局部验证使用 Node 行为测试（建议 node --test），真实标准 UI 消费者通过共享 runner 绑定而非只 mock 自己的 helper。验证 transport 身份、取消与重连至少通过 HTTP 客户端重现；这些不替代真实浏览器验收。worker 返回确切测试文件、命令/退出码、实际宿主覆盖及缺口，Main 回读实现后复核。

禁止导入 cli.js 来探测（scout 已发现它会加载真实用户扩展）。禁止用第二主 runtime 加载当前 session。没有活 TUI/浏览器交互工具时提供可重复手工步骤并返回未验证，不擅自启动额外模型调用。单条命令预计超过两分钟先请求授权；依赖安装如必要只在仓库内、禁 lifecycle scripts，不全局安装。

### Main 实施核验状态

工作组 1 实现级闭合，进入聊天工作组；实际 TUI/浏览器与真实 reload 集成留在最终验收。Main 回读新 runner capture、UI rebind、registry、reload/HTTP 和测试：局部 24 tests 通过，语法检查通过；Pi 原始 wrapper 的事件行为已验证。完整 reload 在 test/helpers/host.js 里由模拟 host 调度，CLI 测试只验证加载与单次 capture/rebind，不能当成真正 AgentSession.reload 已验收。原 worker 更强的报告结论已在 evidence 限定。

## 2. questionnaire 首版明确不支持

用户已确认不适配 questionnaire；原 2.2 实际表单应答任务取消，不再作为 MVP 前置依赖。这不是适配完成。普通问题通过聊天回答，不冒充结构化结果，也不替代授权确认。

- [x] 2.1 完成实际 questionnaire 调查并升级边界。Main 已回读其 custom factory 与结果契约；用户选择暂缓，不修改 OPSX/安装文件，不扩大私有工具执行拦截。
- [x] 2.2 保留 unsupported 时浏览器可见、原调用明确失败、不挂起、不回终端/不自动批准的行为；更新 README 与界面限制说明，不再将 questionnaire 缺失描述为必须修复的 MVP 阻塞。Main opt-in 实际 questionnaire diagnostic 1/1 通过（真实工具、HTTP client，非真实浏览器）。

### Scenario：明确失败而非伪造答案

- **WHEN** 当前安装的 questionnaire 或其他未支持 custom TUI 被调用
- **THEN** 浏览器明确显示不支持，原调用安全失败而不是等待终端输入
- **AND** 标准 confirm 授权仍可在浏览器批准或拒绝，聊天回复不被合成为 questionnaire 结果。

验证使用已有 opt-in 实际 questionnaire diagnostic 与标准 confirm 消费者；不要为提示文案/源码形状增加形式测试。

## 3. 最小聊天与主模型控制

依赖：工作组 1/2 闭合。导航：Pi docs/extensions.md 的 message_*、tool_execution_*、sendUserMessage、getCommands、model_select/thinking_level_select、scopedModels、sessionManager、ctx.abort；源码当前分支历史与 streaming/pending 行为。只读补查未知，不问用户选实现细节。

- [x] 3.1a 单页最小聊天闭环：多行发送、流式回复、停止（ctx.abort），当前分支历史/刷新不重复，浏览历史不强制滚动。实现使用当前 ctx/sessionManager 与 pi.sendUserMessage；Main 回读核心并运行相关 20 tests 全过、语法检查通过。真实 TUI+浏览器验收仍归最终集成，不由本勾选推断最终通过。
- [x] 3.1b 在 3.1a 后补齐 thinking/工具输出折叠、明确 steer/follow-up 交付与状态，闭合完整聊天约定。Main 回读 exact deliverAs 映射、结构化 bounded blocks 与页面 details 渲染；相关 30 tests 全过、语法检查通过，真实流式浏览器见最终集成。
- [x] 3.2a 当前模型/thinking 切换与实际生效回显；候选模型遵循 scopedModels，空 scope 使用可用模型，不暴露凭据、不写默认配置。Main 回读 generation allowlist、公开 setModel/setThinkingLevel 和安全字段快照；相关 60 tests 全过、语法检查通过，真实 provider/browser 见最终集成。
- [x] 3.2b cwd、Git 分支、token/context 用量状态；只读、缺失标未知，不解析/替换 TUI footer。Main 回读 active-branch 聚合、异步 bounded Git 与 dispose；发现并定点修复 partial usage 被误称 total，相关 28 tests 全过、语法检查通过。
- [x] 3.3 浏览器操作严格 allowlist/输入验证，未知 slash/内建 TUI 命令不偷偷发给模型，明确拒绝不支持的入口。Main 回读 exact POST keys、answer action/value 与 getCommands source allowlist；相关 53 tests 全过、语法检查通过。

### Scenario：同一聊天与停止

- **WHEN** 浏览器发送多行普通消息，或运行中选择 steer/follow-up，之后点击停止
- **THEN** 当前 Pi 按指定交付方式接收，页面呈现流式内容和工具结果，停止交给原 ctx.abort
- **AND** 刷新恢复当前分支、不重复消息，不另建主 runtime，不直接修改 session 文件；队列接受不宣称已执行。

### Scenario：模型实际生效

- **WHEN** 用户切换候选模型/thinking，或 setModel 无凭据返回 false
- **THEN** 成功回显宿主实际值，失败明确显示并保持原有效模型；thinking 显示钳制后的值
- **AND** scopedModels 为空时不是“无模型”，不可获取的用量/分支显示未知，不发送 provider secrets。

完成条件：针对公开消息/模型边界的行为测试、真实消费者及浏览器手工/自动化观测；fake DOM 不代替真实页面验证。局部套件按实现新增测试文件运行，最终完整命令统一在 Verify。

恢复顺序：前一 worker 30 分钟只读调查后超时，用户已确认同协议缩小重试，仅派 3.1a。复用其现有调查上下文，不重复全面侦察；3.1b、3.2、3.3 的剩余命令能力与工作组 4 后续串行。中间切片遇到未实现的 busy/命令路径应明确拒绝，不静默丢弃、默认排队或当普通提示发送，不能以中间限制宣称完整 MVP 已满足。

## 4. 子任务只读可视化

依赖：工作组 3 的当前 session 页面。导航：安装 pi-subagents docs/extension-api.md、docs/observability.md、公开 exports；进程内 subagents:rpc:v1:request/reply 与 async 事件。不得 import 私有管理器或解析 session 文件模拟 RPC。

- [x] 4.1 子任务只读列表与按需详情，展示实际状态、模型及输出（公开返回哪些就展示哪些），处理无任务、RPC 不可用和超时。原 worker 超时后 Main 核对部分实现并定点恢复时间字段/README（当时误取 lastUpdate；Verify finding M1 已确认公开字段为 updatedAt，修复批次 packet 1 纠正）；公共 ping/status、fleet key/run ID 分离、固定 detail/refresh 已通过相关 30 tests 与语法检查，真实 owner/browser 见最终集成。
- [x] 4.2 刷新/重连同步子任务现状，父 agent idle 不抹掉 child 运行中状态与完成通知。Main 回读 exact hint subscriptions、one-pending refresh、snapshot-only registry seed 与 detail allowlist；发现并定点修复 retained available/ready 导致的早期 ready race，相关 36 tests 全过、语法检查通过。

### Scenario：异步子任务完成

- **WHEN** 当前父 session 交回控制，但子任务继续运行并完成
- **THEN** 浏览器仍显示真实运行中/完成状态，用户可展开对应详情
- **AND** fleet opaque key 不作为 run ID 使用；RPC 缺失/超时不冒充空列表成功，不发管理或新建任务请求。

完成条件：公共 event bus RPC 的契约与失败测试、实际 pi-subagents 状态回读及活浏览器观察。实际子任务调用受当前委派协议管理，不自行启动 CLI agent。

## 最终审查与交付

修复批次状态：用户共授权批次 #1–#7，均已串行落地并由 Main 逐个回读代码与自查命令（最终 183 tests / 182 pass / 1 opt-in skip，check 退出 0），证据见 [evidence.md](evidence.md)。各批定向确认均已完成（原 reviewer 不可恢复，已用同角色 fallback 并标注），无 blocker。**方向变更**：用户认为「GUI 启动后是否与 TUI 同一会话并不重要，重点是日常使用都在 GUI 里」，因此改用 Pi 公开 SDK/RPC 重建（新 change），本 change 作为已验证原型与复用基线收尾；批次 #7 的末轮确认因此有意跳过（以 Main 8 次全量复测 + 活体冒烟替代，已如实记录）。

- [x] 实现闭合后，两个独立只读 reviewer 分别审查 spec-compliance 与 release-risk；Main 处置 findings，修复需用户批准一个批次及一次原 reviewer 定向确认。已执行：批次 #1–#7 + 多轮同角色 fallback 定向确认；未自动开启新修复轮次，剩余 low/info 项均登记为残余。
- [x] 运行 npm test 与 npm run check 完整套件；执行真实活 session 的浏览器聊天/停止、模型/thinking、标准授权、questionnaire 明确不支持、子任务详情、断线重连及 reload 验收，不以 mock/HTTP 测试代替。已执行：连续 8 次全量干净 + 真实 TUI 会话 + 真实 Chrome/CDP 逐项验收（残余：POSIX symlink 与 bun 无活体验证、启动首帧 git 瞬态自愈）。
- [x] Main 将唯一当前结论写 evidence；未验证或受阻不标通过。已写入（结论为「原型级已通过，但私有接缝架构被否选，作为复用基线收尾」）；创建本地 Commit A；有界知识收口在新 change 的 knowledge 阶段一并做（本 change 不 push、不发布、不全局安装）。
