# Evidence：当前活 Pi session 的轻量浏览器 MVP

公共约定见 [spec.md](spec.md)，唯一任务进度见 [tasks.md](tasks.md)。

## 调查与实验

### 仓库与版本

Main 实测本地 main 为 unborn、工作区只有 .git，无旧 change 或 .aiknowledge。origin 指向用户指定的 shinobuwz/oh-my-pi-gui；scout 的 git ls-remote origin 返回 rc=0、零 ref（当时远端可达且无 refs）。Main 实测 Node v24.16.0 / npm 11.13.0。scout 实测 Pi 0.85.1、pi-subagents 0.67.0。

只读 scout run：14d2813f-52d6-429a-8cef-e95942631b7b；报告为宿主管理产物 gui-mvp-scout.md。报告 changed_files=[]；报告另披露导入 bundle/cli.js 触发用户扩展加载及 project-handoff 诊断，虽未报告落盘，不能称为纯无副作用探测。后续禁止用 CLI module import 做身份检查。

### 主 UI 与 questionnaire 接缝

Main 回读 Pi dist/core/extensions/runner.js:269 起：setUIContext 经过 wrapUIPromptContext 包装 select/confirm/input/editor/custom；withUIPrompt 发通知并等待原 promise。完整 docs/extensions.md 明确 ui_prompt_* 仅观察，工厂阶段不应启动 socket/timer，应延迟到 session_start 并 shutdown 清理。因此不采纳 scout 在 factory 启动服务器的建议。

Main 完整回读实际 ~/.pi/agent/extensions/questionnaire.ts：execute 仅允许 tui mode；normalize 后调用 ctx.ui.custom；组件返回 questions/answers/cancelled，答案 index 为 1-based，并有 wasCustom 与自定义文本 trim 语义。该文件未提供 Web 请求协议。scout 报告其受 OPSX 安装托管，不授权直接修改。

scout 证明 bundle 类身份及加载时序，只能支持“原型 UI 接缝值得实验”的推论，不能证明 browser、实际授权消费者和 questionnaire 已兼容。Main 已完整读取 Pi README/docs/extensions.md/docs/tui.md 及 timed-confirm 示例；API 与生命周期以当前安装源码为准。

## 关键决定与重要验证

- 用户拒绝任何启动后的回终端操作；确认首次从终端启动允许。
- 用户明确接受版本限定的非公开 UI 接缝兼容性原型，仅本仓库、不修改安装 Pi、OPSX 托管扩展或安全授权规则。
- 先验证标准对话框、实际 questionnaire、断线重连，再决定完整聊天与子任务页面；原型不是完整 MVP。
- 不采纳 scout 的断线透传终端、超时回终端和 custom 默认透传建议。断线保留请求，原 timeout/abort 继续有效；不支持的 custom 是显式兼容缺口，不是自动批准或终端回退。
- 不采用第二 RPC/SDK runtime 作为活 session attach，不抢同名工具，不凭 UI 事件推断所有授权已覆盖。

## 实施返回与 Main 局部核验

worker workflow 62426362-7406-4a10-9bce-7c8fadb229c3，child 2e31e034-24eb-4525-914a-7a830a57835f，产物 implementation/browser-interaction.md（宿主管理输出）。实现新增 26 个文件，覆盖 extensions/browser-interaction、src/adapter、src/core、src/browser、test 与 README/package.json/.gitignore；Main git status 核对仅有这些新增文件与 Main 的 openspec，index 为空，未提交。

Main 回读入口、adapter、bridge、request-store、HTTP server、前端、compat、runner-binding tests、README 与 package scripts。Main 执行 npm run test:host：21 tests 全过、退出 0；npm run check：8 个 JS 源码语法检查退出 0。worker 自报完整 npm test：69 tests、68 pass、1 opt-in skip，以及 opt-in questionnaire diagnostic 通过；Main 未重跑完整套件，本次仍是 Implement 局部反馈。

实际实现与原方案不一致：它在 session_start 直接替换共享 ctx.ui 的包装后方法，而不是在原 wrapper 内桥接，所以绕过 ui_prompt_start/end。源码 src/adapter/ui-adapter.js 和 browser-bridge.js 明确承认这一缺口，测试还断言该缺口文案；不符合 spec 的保留生命周期约定，不能作为可接受实现完成。Main 不采纳 worker 的“group 1 delivered”验收结论。

reload 每次新建随机端口/token；src/browser/app.js handleUnauthorized 要求用户回终端取新 URL。旧页面通常访问已关闭旧端口，会走断线重试而不是 README 所述必然 401。runner reload 测试只手动 setUIContext/emit session_start，且旧 token 断言为条件分支，不证明活 /reload 的重连与拒绝闭环。此行为违反启动后不回终端的要求，仍是阻塞。

标准问询测试实际使用安装 Pi 的未打包 loader/runner、独立测试 consumer、真实 HTTP；terminal 为 poisoned stub、browser 为 HTTP 客户端/fake DOM，未执行活 TUI + 真实浏览器。CLI 测试在隔离 RPC 配置中仅检查扩展加载，不是 attach 验收。Main 文本回源 bundle chunk-JVUZSMYM.js 的 wrapUIPromptContext，确认当前 bundle 保留用于 fingerprint 的 ui/withUIPrompt 片段；并未因此证明运行可用。worker 关于“scout 原型身份陷阱”的泛化结论不采纳：scout 已区分 bundled/unbundled；不得把一条实现选择解释成其他接缝都不可达。

## 用户确认后的范围调整

用户明确确认“暂缓 questionnaire，保留浏览器授权确认与普通聊天问答”。原实际 questionnaire 浏览器表单任务取消，改为明确 unsupported、安全失败；不再申请/实施 OPSX 跨仓库修改，也不扩大私有工具执行拦截。该决定只豁免结构化表单，依赖此工具的流程仍可能失败，不能合成聊天回复冒充工具结果。

按原 MVP 目标继续本仓库：先修复标准问询生命周期与 reload 无终端重连，再完成最小聊天/模型 thinking/状态与子任务只读视图。既有 26 个新增实现文件属于前 worker，Main 的三文档归 Main；最新 git status 仍是 main unborn/index 空、无额外未知源码路径。

同宿主进程 reload 需保持浏览器可发现的入口与认证连续性；旧代际操作必须作废、旧 ctx/监听器释放，真实退出清理服务器。允许为 reload 保留本进程连接资源，不允许第二 runtime、绕过认证或传播旧批准。这是重连实现约束，不新增跨进程自动恢复功能。

## 生命周期修复与 Main 核验

后续 workflow 26a884fe-8254-446e-a6bd-5886bbd95791，child 46b2c582-cd77-4f88-bf69-2a4fc0e74a74，宿主输出 implementation/browser-lifecycle-fix.md。新增 runner-capture.js、bridge-registry.js、observer-extension fixture；更新 adapter/bridge/server/store、入口、浏览器及相关测试/README。Main 核对 git status：仍 main unborn、index 空、所有变更在此前批准的本仓库实现路径及 Main 文档。

Main 回读 runner-capture、ui-adapter、browser-bridge、registry、extension、HTTP reload、CLI tests、host harness；源码采用捕获实际 runner 后 setUIContext(bridgeContext)，让 Pi 自身 wrapUIPromptContext 包裹桥接方法，修复绕过生命周期的根因。进程 registry 保存 server/store/代际与当前处理器，reload detach 清理实例绑定、下一实例 adopt 同一地址/token。Main 回源当前 Pi AgentSession.reload 与 InteractiveMode.handleReloadCommand，核对其原生调用链与 streaming/compacting 拒绝条件。

Main 执行：node --test --test-timeout=60000 test/runner-binding.test.js test/cli-extension-load.test.js，24/24 pass、退出 0；npm run check，10 JS 源码语法检查通过；PI_BROWSER_UI_QUESTIONNAIRE_PATH 指向只读实际工具的 diagnostic，1/1 pass、退出 0。覆盖宿主原始 start/end、并发/嵌套合并、标准对话框结果、HTTP 断线重放、模拟 reload 同地址/token、旧回答拒绝、明确 unsupported 与清理。

证据限制与报告纠正：test/helpers/host.js 的 createHostHarness 自行模拟 shutdown/invalidate/load/boot，未调用实际 AgentSession.reload；test/cli-extension-load.test.js 只有两个测试（真实 CLI 加载、另一个临时 probe 的 capture/rebind/单次事件），没有报告所称永久真实 reload probe。报告中其他一次性探针日志仅属 worker 自述、Main 未回源，不计为验证通过。模拟 host 的 waitForIdle 默认 stub，不能证明真实运行中 reload 无死锁。已有局部行为足以继续依赖其接口开发，但实际活 TUI+浏览器、真实完整 reload 与子任务通知列为强制最终集成缺口，未最终通过。

## 聊天工作组委派超时

workflow 5b233607-c3d9-443b-9aad-f414d12f42de，child 3f6e2734-eaa1-4e76-b0f5-9da8b37baed4：failed，Subagent timed out after 1800000ms（30 分钟）。Main 查询状态确认无 active child；无完成产物。运行环境仍 E:/gitlab/oh-my-pi-gui、main unborn/no HEAD、index 空。工具自动恢复的 git diff HEAD 因 fatal: bad revision 'HEAD' 失败，不能据此声称没有改动。

Main 核对本次 child transcript：96 次工具调用（52 read、32 grep、8 find、2 ls、2 bash），没有 write/edit；两条 bash 仅统计安装文档行数及 git status/diff 与版本查询，未执行写入或测试。磁盘文件列表与此前一致，源码修改时间均早于本次 launch。由调用证据与现场联合判断：本轮没有产出聊天/模型实现，也没有新增验证；旧基础实现保持现场，不把它算作本轮成果。

Main 以 git ls-files --others --exclude-standard 列出的 32 个文件保存完整源码/文档快照至 C:/Users/N22116/AppData/Local/Temp/oh-my-pi-gui-timeout-partial-20260914-222622.zip（不含 gitignored 运行 URL/token，不是 Git 基线或第二任务状态）。未 stage/commit、未清理文件、未切换到 CLI/foreground/inline fallback，未自动重试。

本轮长时间停留于调查且无实现进展，暂停派发并向用户报告。用户随后明确确认同一 native subagent 协议下缩小重试：先聊天发送/流式/停止，模型/thinking 后续串行。Main 再核对 main unborn/index 空与相同路径集合，children.list 确认失败 child 可恢复，选择恢复其既有上下文以复用调查而不再全面侦察。tasks 将聊天拆为 3.1a 最小闭环和 3.1b 后续交付/折叠补齐，不改变整体 spec，不新增发布/安装权限。

## 最小聊天恢复实现与 Main 核验

用户确认缩小后，workflow e3cc5f1d-d7d3-4987-9fda-944a066591ac 恢复原失败 child，实际 child ec56712a-76ce-4354-946b-20d5b5790fd4 完成；宿主输出 implementation/browser-chat-minimal.md。新增 src/adapter/chat-bridge.js、test/chat-bridge.test.js、test/chat-server.test.js，并更新 registry/server/browser-bridge/extension/page/README/package 与相关测试；未改 openspec、安装环境或 Git。

Main 回读 chat-bridge.js：历史取 buildContextEntries，事件维护 live assistant 记录并在 agent_end/session_compact/session_tree 回源；普通消息只在 idle 发送，使用 pi.sendUserMessage(text,{expandPromptTemplates:true})；未知 slash 命令先与 pi.getCommands allowlist 比对；busy 明确拒绝；stop 调当前 generation ctx.abort；dispose 清除 ctx/pi 引用。该切片有意不支持 steer/followUp、thinking/tool rich folding、模型/状态与子任务。

Main 运行 node --test --test-timeout=60000 test/chat-bridge.test.js test/chat-server.test.js test/browser-page.test.js：20/20 pass、退出 0；npm run check：包含 chat-bridge 的 11 个源码语法检查通过。worker 自报完整 npm test 91 tests（90 pass、1 opt-in skip），Main 未在 Implement 阶段重跑完整套件。局部 HTTP/fake DOM/公开 API shape 证据不替代真实 TUI+浏览器流式模型调用；未启动付费模型调用。

Main 核对现场：main unborn、index 空，新增路径只比此前多 chat-bridge 与两个 chat tests，未见未知所有权文件。3.1a 实现级闭合，继续串行 3.1b，不将中间切片宣传为完整聊天或 MVP。

## 聊天交付模式与折叠实现

workflow 47b18b2e-7fca-49d1-b556-509c144bc7e7，child 73e6bfb8-511a-4ecb-9e38-2ad27810732f，宿主输出 implementation/browser-chat-delivery-folding.md。该 run 一度达到 63 turns/97 tools/约 274k tokens；用户询问耗时后，Main 定向 steer 要求停止调查、完成当前编辑与最小验证，随后正常完成。后续继续保持小切片。

实现更新 chat-bridge、extension 消息事件、浏览器页面/CSS、README 与三类测试：busy steer/followUp 使用 Pi 精确 deliverAs "steer"/"followUp" 且 expandPromptTemplates:true；idle 非 normal 选择归一为即时 normal 并明确回显；thinking、toolCall、toolResult 分块、bounded、DOM textContent + details 折叠；工具参数按敏感 key 做有限脱敏，未知 provider blocks 不输出；live tool execution 与 canonical result 按 toolCallId 对齐。

Main 回读实际实现与 tests，并运行 node --test --test-timeout=60000 test/chat-bridge.test.js test/browser-page.test.js test/browser-assets.test.js test/factory-contract.test.js：30/30 pass、退出 0；npm run check 退出 0。该证据覆盖公开 API shape、HTTP/page fake DOM 与安全静态边界，不证明真实浏览器、真实 provider stream 或命令/工具参数中非结构化秘密文本的完全识别。3.1b 实现级闭合，不作最终安全/产品验收。

## 模型与 thinking 控制

workflow 34cf2277-ac52-4f4f-ab18-f18d94312a69，child 312d9f4a-05b6-4e59-b7ed-db9bd619353a，输出 implementation/browser-model-thinking.md。实现新增 generation-scoped ModelBridge、固定 /api/model 与 /api/thinking 路由和浏览器原生选择控件。候选严格从当前 ctx.scopedModels 或空 scope 时 modelRegistry.getAvailable() 重建，按 provider/id 去重且浏览器只提交 allowlisted key；快照不复制 auth/baseUrl/headers/provider 对象。切换调用公开 pi.setModel / pi.setThinkingLevel，回读 ctx.model 与 getThinkingLevel 实际值，不传 persist，不写默认配置；旧 generation/dispose 拒绝操作。

Main 回读 model bridge、HTTP boundary、浏览器测试和 Pi 0.85.1 agent-session 实现，确认宿主 setModel 无 auth 时实际为 throw（桥同时兼容任务约定的 false），默认 options.persist 未启用；setThinkingLevel 由宿主按模型能力钳制。运行 model/page/server/chat/factory/runner-binding 相关命令：60/60 pass、退出 0；npm run check 退出 0。证据未执行真实 provider/auth/model 调用，也未运行真实浏览器，3.2a 仅实现级闭合。

## cwd、Git 与用量状态

workflow e40e18e0-459e-479a-aaee-2ff2c87b25cf，child 644be552-4cab-49c3-8a6d-02062f07ea48，定点 follow-up be69a685-b975-4e5c-a957-0688a3c6859e；输出 implementation/browser-session-status.md。实现新增 generation-scoped StatusBridge：cwd bounded；context 使用公开 ctx.getContextUsage 并以当前 model contextWindow 作窗口 fallback；session token 仅聚合当前 branch 的公开 usage 字段；Git 通过 fixed argv、shell:false、timeout/maxBuffer 的异步 execFile 读取 symbolic/unborn/detached 状态，失败只返回 reason code。浏览器只读显示并将缺失值标 Unknown；dispose 清 timer/child/ctx 并忽略 late callback。

Main 回读后发现初版在部分 usage 字段缺失时仍把已知分量显示为 total，可能把 partial sum 冒充完整总量；原 worker 定点修复为只有每个已识别 usage 对象的四个分量完整有效且求和有限时 total 才为数字。Main 运行 status/page/assets：28/28 pass、退出 0；npm run check 退出 0。真实 Git/TUI/browser 联动仍待最终集成。

## API 与 slash command 收口

workflow d11cb89b-8d0e-45f2-a507-f56b7a587aa4，child 0a286435-4d3f-4e95-a46e-02f9ef3201ba，输出 implementation/browser-api-command-hardening.md。HTTP 层增加逐 POST route 的 exact key allowlist：reload 仅空对象，answer 仅 id/action/value 并约束 answer/cancel/dismiss 的 value presence，message/stop/model/thinking 禁止额外字段；保留 adapter 的值/代际验证与固定 route dispatch。Chat slash 仅接受字符 0 的 `/`、非空 token、当前 pi.getCommands 中 name 精确匹配且 source 为 extension|prompt|skill 的描述；内建 TUI、未知、畸形、空 slash 和 whitespace trick 不调用 sendUserMessage。

Main 回读确认浏览器现有错误展示不会把 rejection 写成 accepted；运行 bridge/chat/model/page 相关测试：53/53 pass、退出 0；npm run check 退出 0。真实 Pi extension/prompt/skill command 执行仍待最终活 session 验收。

## pi-subagents 只读列表与详情

首次 workflow 784406af-c1e5-4f73-9830-7bd6559ac76f 因任务模板内反引号导致 JavaScript parse failure，未创建 child/未修改仓库；核对无 active fleet 后以同协议重试。workflow 83e0aaff-4da2-45ef-82f7-02ecd2cf6aa3 的 child e4cad1c8-d0e9-4daf-9353-b720c23aa243 随后在 30 分钟上限超时（124 turns、181 tools、约 523k tokens），留下部分实现但无完成报告。Main 检查 modified mtimes、完整核心文件和 timeout transcript，运行部分实现相关套件 56/56 pass、check pass；当时把 async DTO 时间字段误判为公开 lastUpdate（Verify 已按安装源码纠正为 updatedAt，见下），随后仅定点恢复 6df2976d-3354-47e4-8b69-41d517c61a4e，禁止继续脱敏调查/扩大范围并完成 handoff implementation/browser-subagents-readonly.md。

实现使用公共进程内 subagents:rpc:v1 request/reply，仅 ping/status；缓存 bounded fleet 与 asyncSnapshot，fleet key 仅展示，detail 只接受当前 allowlist 的 async id 并固定 view=transcript/lines=80；HTTP 只读 detail/refresh 固定路由保留 token/Host/Origin/generation/exact-body。页面区分 loading、empty、data、timeout、RPC error、omitted，并以 textContent 渲染。Main 最终运行 subagents bridge/server/page、browser page/assets：30/30 pass、退出 0；npm run check 退出 0。未对真实 installed owner 发 RPC，路径/输出投影的产品适切性仍需 release-risk 审查与活浏览器验证。

## pi-subagents 事件与重连同步

workflow 1582ab86-a256-436a-8a27-465a109e39d3，child e1635481-308f-42a6-bc04-8d9481e28ebe，定点 follow-up 4dac76da-ebc5-4d83-b60b-dc6c81bbc608；输出 implementation/browser-subagents-events.md。SubagentsBridge 订阅 ready、async-started、async-complete、child-status 作为 refresh hint，不信任 payload；burst debounce，in-flight 期间用单 boolean 保留一次 follow-up。dispose 清 hint timer/subscription/RPC。registry 仅保留 defensive bounded DTO snapshot 供 reload gap 显示，旧 sessionControl/ctx 不保留；新 generation 初始 async detail allowlist 为空。

Main 回读发现 seed 初版继承 available=true/ready-data，既可能把 retained rows 暂称当前权威，也会忽略 initial ping 期间的早期 ready hint。原 worker 定点修复为 seed rows 仅显示，状态强制 available=false/loading/error=null，ready hint 在 initialBusy 后恢复 ping->status。Main 运行 subagents bridge/server/page、browser page/assets：36/36 pass、退出 0；npm run check 退出 0。工作组 4 实现级闭合，真实 owner event、父 idle completion 与浏览器 reconnect 仍需最终活验收。

## 未解决问题与验证边界

实现工作组已闭合，进入 Verify。尚未完成两个独立 reviewer、完整 npm test/check 和真实活 TUI+浏览器验收。questionnaire 明确失败已局部验证，仍不承诺结构化表单。真实浏览器/TUI、生产适配完整 reload、真实 stream/abort、reload 时存活子任务通知和失败恢复尚待最终集成。工具参数中嵌入普通字符串的秘密无法靠 key 脱敏可靠识别，最终审查需判断显示边界。Pi 内建配置/登录/会话菜单与其他 custom TUI 未纳入首版自动适配，GUI 不暴露其入口。当前代码不是可验收 MVP，继续 Implement，不进入正式 Verify。

## Verify 独立审查

workflow 3abf4755-7746-40a3-b08a-8cd1e2794b96；spec-compliance reviewer c730b759-9925-4ebb-ad42-2b9cf47a0cd0，报告 review/spec-compliance.md；release-risk reviewer 9b8ff221-4dc4-4df7-99a3-223c76dd9008，报告 review/release-risk.md。两者均独立运行完整 npm test（132 total，131 pass，questionnaire opt-in 1 skip）与 npm run check；spec reviewer 另运行实际 questionnaire diagnostic 1/1 和 CLI probe 2/2。

共同确认无 blocker 级认证/授权缺陷，但 MVP 不能在未完成真实 TUI+browser/provider/reload/pi-subagents owner 验收时接受。共同代码 finding：pi-subagents asyncSnapshot 实际公开字段是 updatedAt，本实现/tests/tasks/evidence 错用 lastUpdate；Main 已直接核对安装源码 async-status-projection.ts。Spec reviewer另确认 busy extension-source slash command 在 Pi prompt 路径会先立即执行，当前页面错误宣称 queued。

release-risk 还报告：全历史 state 每 600ms 重传并重建 DOM 的高负载；commandContext.reload 无 watchdog 可永久锁 reloading；toolResult canonical/live key 不一致会暂时重复；异步 sendUserMessage 后续失败未展示；Node execFile timeout killed/SIGTERM 被误判且二次执行 Git；detail/path/secret 脱敏与 README 绝对承诺不一致；reload attach-failure 文案、HTTP char/byte limit、失败后旧 detail allowlist 等低/中风险。Main disposition：L2 refused reload 前取消 pending 属安全优先且为用户显式 reload，不单独修；fake DOM scroll 只留真实验收；runner prototype patch 在正常 global state reload 不重复包装，暂不改。其余建议组成一次 bounded fix batch，等待用户授权；OPSX 不自动循环修复。

## 修复批次结果与 Main 核验

三个 packet 串行落地，每个 packet 均由 Main 回读实际代码并自查命令后确认，不采用 worker 自述结论。

- packet 1（run d4656182-c26f-4764-b322-9da75883bb3e，F4/M1、F3、F6、M2、F10、F5、README L1/L5）：改动 README.md、src/adapter/chat-bridge.js、src/adapter/subagents-bridge.js、src/browser/app.js 与四个测试文件。Main 抽查确认：updatedAt 优先于 lastUpdate fallback 且页面渲染 updatedAt；两处去重统一为同一序列化 key 并按 canonicalToolCallId 去重；streaming + extension 源命令返回 execution=immediate/queued=false 且附带说明，prompt/skill 仍 pending；失败清空 detail allowlist；Bearertoken 与 key=value 形态脱敏且普通路径文本保留。Main 运行 npm test：138 total / 137 pass / 1 opt-in skip、退出 0；npm run check 退出 0。
- packet 2（run 456924df-9de7-4bac-9fae-e972cad3a99c，F2、F8、F7、F9）：改动 README.md、extensions/browser-interaction/index.js、src/adapter/browser-bridge.js、src/adapter/status-bridge.js、src/core/bridge-registry.js、src/core/request-store.js 与五个测试文件。Main 抽查确认：reload 受 PI_BROWSER_UI_RELOAD_TIMEOUT_MS（默认 45000）约束，超时返回 504 reload_timeout 并释放锁；registry 新增 attachFailures/lastAttachError，reload 后 generation 未动且失败计数增加时返回 503 attach_failed 并保留共享 server 以便页面真正收到该错误；isGitFailure 覆盖 killed/SIGTERM，超时不再执行第二条 git；maxBodyBytes 提到 320 KiB。Main 运行 npm test：145 total / 144 pass / 1 skip、退出 0；npm run check 退出 0。
- packet 3 首次尝试 run 031a1d47-4f1a-4168-a69a-db0cd7882db7 因上游 provider 503（auth_unavailable、codex 过载）在启动阶段失败。Main 以 mtime 与 messagesFull/historyIds/chatSince 标记核对确认零改动，无部分 diff，随后同协议重试。
- packet 3（run 039c19a8-4bd5-4e4f-8662-05cd80e1ad91，F1）：改动 README.md、src/adapter/browser-bridge.js、src/adapter/chat-bridge.js、src/browser/app.js、src/core/bridge-registry.js、src/core/bridge-server.js 与三个测试及 test/helpers/fake-dom.js。Main 抽查确认：消息 revision 由统一 key 维护并在内容变化时保证严格递增（含 <= 上一值的防御性回提）；since 仅接受单个 1-12 位十进制数字，非法/超前回退全量，since == revision 时返回空数组与 historyIds=null；generation 变化时页面显式重取无 since 的全量状态，避免跨代际合并增量；渲染仅在 revision 变化时重建，并按 historyIds 剪除消失的 id。Main 运行 npm test：150 total / 149 pass / 1 opt-in skip、退出 0；npm run check 退出 0。

三个 packet 之后 Main 核对 git 现状：main 仍为 unborn、index 空、文件集合与批次前一致（无未知所有权文件、无 staged 内容）。后续仍需：原 reviewer 一次定向确认（或同角色 fallback 并标注）、完整 npm test/check、真实活 TUI + 真实浏览器验收。

## 修复批次（用户已授权）

用户确认继续后，Main 按上述 disposition 组批并串行派发；同 worktree 单 writer，packet 之间不并行。被拒项不进入批次：L2（refused reload 前取消 pending，安全优先且为用户显式 reload）、L3（fake DOM scroll 只留真实验收）、F11（runner prototype patch 在正常 global state reload 不重复包装）。

- packet 1（数据真实性与显示正确性）：F4/M1 updatedAt 字段与渲染、F3 toolResult 去重 key 统一、F6 lastError 渲染、M2 extension 源 slash 命令 execution 区分、F10 失败后清空 detail allowlist、F5 明确秘密形态脱敏 + README best-effort 改写、README L1/L5 文档一致性。run d4656182-c26f-4764-b322-9da75883bb3e。
- packet 2（生命周期与限额）：F2 reload watchdog、F8 reload 失败原因区分、F7 Git timeout 分类与二次执行、F9 请求体上限与界面 limit 一致性。run 456924df-9de7-4bac-9fae-e972cad3a99c。
- packet 3（规模与渲染）：F1 每 600ms 全量 state + 全量 DOM 重建。run 039c19a8-4bd5-4e4f-8662-05cd80e1ad91。

packet 结果以 Main 回读实际 diff 与命令证据为准，不采用 worker 自述结论。

## 批次 #1 的定向确认

因原 reviewer 不在当前会话保留子任务中，Main 以同角色 fallback（已标注）组两条只读 lane 做一次定向确认，交接了原 findings、获准范围与 Main 的验证证据。结果：release-risk lane 11/12 resolved，spec-compliance lane 11 项 resolved，无批次引入的 blocker；两项未达成——F6 的信号源在已安装公开 API 上不可达（宿主 sendUserMessage 返回 void 并自行吞掉 rejection，只有 promise 替身能走通），F8 在 post-bump bind 失败时因 registry.reloading 被提前复位而 release 掉共享 server，反而销毁了本应携带 attach_failed 的响应。另报 LOW-1（清 lastError 擦掉接受文案）、LOW-2（README 面板描述）、W3（客户端缓存不剪除）、W5（两个 F1 分支无 committed 测试）、W2/W4/OPTIONAL-1 残余。Main 回读核实了 F6 与 W1 两条关键结论后，向用户申请并获批修复批次 #2。

## 修复批次 #2 与定向确认

用户批准批次 #2 后派发单一 worker。该 worker 在实现完成并自跑 npm test（154 tests / 153 pass / 0 fail / 1 opt-in skip，check 退出 0）之后、写报告阶段超时（无自述报告）。Main 未采信其自述，而是回读实际代码并重跑 npm test / npm run check（与 worker 自跑一致）后确认交付有效；期间用户尝试的活会话启动因该 worker 尚未写完 browser-bridge（#subscribeRunnerErrors 未定义）而解析失败，Main 核对后确认属编辑中间态，随后语法与套件恢复正常。

批次 #2 的 7 项（Main 与两条只读确认 lane 均已核对）：F6 改用宿主错误通道（runner.onError + event 过滤、代际守卫、有界文本、detach 退订、无 onError 时只报「可见性不可用」不伪造）；F8/W1 新增 registry.reloadInFlight 并在 requestReload 全部返回分支与 detach/quit 清除，extensions 入口据此保留共享 server，使 post-bump bind 失败仍真实返回 503 attach_failed；LOW-1 仅在状态栏仍显示该错误时清空；W3 增量路径按 historyIds 剪除客户端缓存；W5 补齐 since 超前与代际切换全量重取两条测试；LOW-2 修正 README 面板描述；W2/W4 修正 504 文案与成本描述。

定向确认同样为同角色 fallback（已标注）：release-risk lane 独立复核 7/7 resolved，无 blocker、无批次引入回归，并用真实 loader/runner + 真实 HTTP 探针验证锁在 refused/busy/timeout/in-flight/quit/post-bump 各路径均回到 {false,false}、post-bump 与 pre-bump 两种失败都保活并真实返回 503、旧代际操作被拒、重试不会启动第二个 reload、W4 成本与文档一致。spec-compliance lane 首次因自身失控的递归扫描超时且无输出，Main 以同角色 fallback + 硬预算重派后 PASS：4/4 resolved，且 spec.md 的授权/非批准、ui_prompt_start/end 生命周期、不支持 custom 明确失败、只读子任务边界均未破坏。

确认阶段报出并由 Main 登记的残余（均非阻塞，不另开修复轮次）：F-1 attach_failed 保活路径下页面同时显示已重连与 chat 不可用，且 Subagents 面板把保留快照改标为当前 generation（异常恢复路径，与 spec 的「不把保留行当当前权威」存有张力，记入残余）；F-2 代际切换/成功后状态栏可能残留上一代际的投递错误文本（批次前已存在）；F-3 退订与「无可视性」分支只有实现而无 committed 断言（已由探针补证）。其余（页面并发轮询无 in-flight 保护、504 后后台 attach 失败不再保留 server、真实投递拒绝未在活体制造）记入验证边界，不视为缺陷。

## 真实活体验收发现：capture 在真实 TUI 下从未生效（硬阻塞）

用户按约定在终端执行真实启动命令时，扩展报告：

```
ExtensionRunner.setUIContext was never observed in this process
Browser UI not started: the running ExtensionRunner could not be captured; the browser UI refuses to enable instead of falling back to terminal prompts
```

`/browser-ui status` 给出决定性证据：`Runner capture: failed: could not import @earendil-works/pi-coding-agent from inside the host process: Cannot find package '@earendil-works/pi-coding-agent' imported from E:\gitlab\oh-my-pi-gui\src\adapter\runner-capture.js`（`Pi version: (unknown)`，因为 attach 未完成）。

Main 用受控实验（仓库内临时探针 + 真实 TUI 窗口 + 子进程对照，事后已删除临时目录，仓库文件未改）确立：

- 裸 specifier 的解析失败与运行模式无关，而与**扩展模块所在位置**有关：同一代码放在系统临时目录可成功解析，放在本仓库内则字面量与 computed `import()` 都失败（原生解析从仓库路径向上找不到全局安装的包）；jiti 的 virtualModules 未覆盖这条路径。
- 真实 TUI 下改用绝对路径 `import(file:///<packageRoot>/dist/bundle/index.js)` 可拿到活的 `ExtensionRunner`（宿主的 `dist/bundle/index.js` 重新导出 `chunk-JVUZSMYM.js` 的同一模块实例），对其 `prototype.setUIContext` 打补丁在 `session_start` 命中 2 次。
- 既有测试为何漏掉：`test/cli-extension-load.test.js` 的 capture 探针由 `writeCaptureProbe()` 写进 `mkdtempSync()` 的临时目录，恰好落在能解析的一侧；而加载真实 adapter 的那条测试只断言命令注册，不断言 capture。

结论：这是**真实部署形态下的硬阻塞**（浏览器 GUI 在活会话里根本起不来），不是修复批次引入，也未被前两轮全量测试与两轮确认发现——只能由真实活体启动暴露。修复方向：宿主类按 `argv[1]` 解析出的宿主包绝对路径导入（bundle entry 优先，dist main 次之，裸 specifier 仅作 fallback），保留注入钩子、指纹校验与 fail-closed；回归测试必须用**仓库内** fixture 加真实 bundled CLI 子进程断言 capture 真的发生。用户已批准批次 #3，并同意用现有 TUI 会话 `/reload` 验证。

## 真实活体验收（批次 #3 修复后）

环境：用与用户命令同形的参数起一个**真实交互式 TUI 会话**（最小化控制台窗口，真实 agent 目录与真实 provider/模型），外加 Chrome headless + CDP 驱动（零依赖，自写的 temp harness，不进入仓库）。URL/token 由运行中宿主写到临时 URL 文件后由 harness 读取。

批次 #3 修复前后对比（同一命令）：修复前扩展报 `ExtensionRunner.setUIContext was never observed` 且拒绝启用；修复后 URL 文件成功写出并 attach 成功（capture 在真实 TUI 下生效）。

逐步结果（全部真实宿主 + 真实浏览器，非 fake DOM/HTTP 替身）：

- 加载/令牌流：通过（`#t=` 片段→sessionStorage、`#auth` 隐藏、显示 Connected）。
- 状态面板：通过（cwd 正确；git 分支 `main`；首帧会话 usage 未知→完成一回合后显示真实 token 数 14539/7/14546 与 context 数据）。
- 模型/thinking：通过（12 个候选；thinking 由 max 切到 off 并回显实际生效值；未暴露凭据）。
- 聊天与流式：通过（多行消息；真实模型精确回出 marker；行数在同一 revision 下不重复；发送后无强制滚动）。
- 停止：通过（streaming 中 Stop→回到 Idle）。
- 未知 slash：通过（明确拒绝且不产生聊天行）。
- 滚动保持：通过（真实布局下 streaming 期间 scrollTop 不被拉到底）。
- 标准对话框：通过（confirm/select/input/editor 均在浏览器回答，consumer_probe 拿到结果；custom 显示 unsupported 且原调用明确失败）。
- 宿主生命周期：通过（observer 报告 confirm/select/input/editor/custom 五类各有宿主自产的 start/end 对）。
- questionnaire：通过（先排空旧卡片后要求新 id，新的 custom 卡片明确 unsupported，工具调用失败而未被合成结果）。
- 安全拒绝：通过（错误 token 401；多字段体 400；用 Node 原始 HTTP 伪造 Origin 403、伪造 Host 403、服务器侧多余字段 400；写操作无 Origin 也会 403）。
- 子任务面板：部分（真实 owner 下 `Ready · empty`，如实显示无 fleet/async 行；**没有活 async 子任务行可验**，见残余）。
- 断线重连：通过（有待答问询时刷新页面→同一 request id 重新出现，历史行数 35→35 不重复）。
- 浏览器发起 reload：通过（无阻塞问询时真实 `AgentSession.reload` 完成，generation 1→2，URL/token 不变，chat/controls/status/subagents 重新绑定；新页面加载仍 Connected）。
- reload 与待答问询：符合安全方向但有 UX 取舍（有待答对话框时 agent 正在 streaming，reload 返回 409 busy；该待答请求在此前的 `store.cancelAll("reload")` 已被非批准结束，旧 id 再答得 409 already_resolved）——这是早先 review 的 L2 的活体证实，Main 仍维持“安全优先”的 disposition，但用户可见行为应写入文档。

活体发现（非阻塞）：

- 启动后首次 git 解析会短暂返回 `not_repo`（页面显示 Unknown），随后自愈为 `main`；直接驱动 StatusBridge 与在 Pi 进程内跑同样 git 命令都得正确结果，属启动瞬态。建议后续把这种瞬态与真实失败区分（仅在后续处置，不阻塞）。
- 子任务面板只验证了空状态；带真实 async run 行的展示与 detail 仍需在有活子任务时验收。
- 分发器（temp harness）自身的竞态与断言错误已在过程中修正，不计入产品缺陷。

## 批次 #3 定向确认与 flaky 发现

同角色 fallback 两条只读 lane（已标注）均确认：**6/6 交付内容 resolved，无本批次引入的 blocker**；且回归防护经实证有效（把解析改回裸 specifier 会让新增的仓库内 fixture 用例失败）。两 lane 均独立用受控实验验证了候选顺序、单候选 fail-closed、bun 入口明确失败、真实 bundled/unbundled CLI 下 source=bundle/dist 且 captures≥1。

报出的处置项：

- flaky 测试（spec lane W-2，最高优先）：test/runner-binding.test.js 的 reload 窗口用例使用固定 sleep(50ms) 与 URL 文件时序竞态，reviewer 聚焦运行 15 次中 4 次失败、全量 8 次中 1 次失败。**Main 独立复现并量化：全量套件 5 次中 4 次干净、1 次 fail=1；聚焦 runner-binding 6 次中 4 次干净、2 次 fail=1**。因此本 change 先前「套件全绿」的表述改为「单次运行结果，不具可复现性」，直到批次 #4 修正。
- 入口形态健壮性：POSIX 全局安装的 symlink bin 下 argv[1] 非 realpath → 找不到包根 → fail-closed（不启用）；bun/SEA 编译型运行时无 on-disk 包根，而当前实现在包根解析失败时立即 fail-closed，使裸 specifier 兜底（改动前唯一的路径）不可达，构成能力回归风险（reviewer 标注为推理，本机无 bun）。
- 诊断与覆盖：存在「装错副本但报告 ok」的窗口（captures=0 时 status in patchInstalled=true 不显示原因）；「单候选、不加载第二份宿主图」不变量与 status 失败分支无 committed 断言；另有 attempts 语义、失败时 source 回滚、host.js 死导出、README status 行等小项。

用户已批准批次 #4（覆盖以上全部 6 类：flaky 修正、argv realpath、specifier 兜底、诊断、测试补齐、小项），并要求补验子任务面板（见下）。

## 子任务面板活体验收（补齐最后缺口）

在真实 TUI 会话里让 agent 真实派一个后台异步子任务（agent scout），然后在真实浏览器面板上验证：

- 面板状态：`Ready` / `1 fleet entry · 1 async run`。
- Fleet 行：`fleet-1`（opaque key），**没有任何 transcript 动作** → fleet key 与 run id 分离成立。
- Async 行：`scout (f3d0adc9-…)`，含 state queued、mode subagent、started 与 **真实 `last update: 2026-09-16T02:51:06.856Z`**——这是 F4/M1 的 `updatedAt` 修复在**真实 owner** 下生效的直接证据（修复前该字段恒为 Unknown）。
- 详情：点 View transcript 返回**有界 tail**（自标 `Transcript detail (bounded tail)`、run id、state running，并如实写 `no transcript lines available yet`）。

至此 spec 要求的九类活体表面（聊天/停止、模型与 thinking、标准授权、questionnaire 不支持、子任务列表与详情、刷新/断线重连、reload）均有真实宿主 + 真实浏览器证据。

## 修复批次 #4 与 flaky 处置

批次 #4 分两次 worker 完成（第一次因上游流中断，在 26 turns 处失败；Main 核对现场后用同协议续作，只做剩余项）。内容：入口解析增加可注入 realpath（覆盖 POSIX symlink bin）；包根解析失败时改为继续尝试字面量裸 specifier 兜底（bun/SEA 形态能力恢复）并合并两类失败原因；诊断增加 usedSource/candidateUrl 且 status 成功/失败两分支都输出来源与尝试信息；删除 host.js 死导出、README 补 Runner capture。

flaky 的处置过程本身值得保留：第一次修复只针对特定固定 sleep，worker 自报「npm test 3/3 干净」，但 **Main 独立复测 8 次中 2 次失败**（两个不同测试：stalled-reload 与 unsupported custom，均在约 3.0s 处超时），根因是 helper 的有界等待默认上限仅 3000ms，在全量并行（含 CLI 子进程重负载）下偏小。Main 把这份实测证据 steer 给运行中的 worker，要求把 limit 提到 15000ms、保留轮询与断言强度、并改为连续 8 次全量复验。

最终 Main 独立复测（不采信自述）：聚焦 test/runner-binding.test.js 连续 **8/8 干净**；全量 npm test 连续 **8/8 干净**（每次 162 tests / 161 pass / 0 fail / 1 opt-in skip）；npm run check 退出 0；仓库无 node_modules 残留。新增测试经回读确认断言真实行为：单候选不变量用例用临时 fake 包根 + import 副作用 marker 证明第二个候选与裸 specifier 均未被求值，并断言 usedSource=null / attempts=1 / candidateUrl 形态，且在 finally 中清理临时 node_modules 槽位；symlink 用例用注入 realpath（不依赖 OS symlink 权限）；另有 status 失败分支断言。

## 批次 #4 定向确认：flaky 的真正根因是禁用端口（产品缺口）

两条只读 lane 均给出「无本批次引入的 blocker」，但都指出部分项只做到 partially-resolved，且 risk lane 挖出了 flaky 的真根因：

- **禁用端口（产品级、改动前既有）**：src/core/bridge-server.js 以 port 0 绑定 127.0.0.1，可能被分配到 WHATWG/browser 禁用端口（bad port list，含 6000、6566、6665-6669、6697 等）；此时服务端确实在监听、URL 文件也会写出，但 **Node fetch 与浏览器都会拒绝该端口**（实测 `fetch failed | cause: bad port`；浏览器为 ERR_UNSAFE_PORT）——用户拿到的 URL 打不开且不报错。Main 已独立复现：本机 dynamic port range = 1024 起 13977 个（覆盖禁用列表）；在 6000 上 listen 成功、对其 fetch 失败。之前活体验收拿到 12343/12513/4988 属于未命中。
- **测试 flaky 的真因就是同一件事**：harness 对桥 URL 的 fetch 撞上 bad port 后一直重试，所以批次 #4 把等待上限从 3s 提到 15s 只把失败变慢（risk lane 18 次全量仍 2 次失败），而非修好。
- POSIX symlink 形态仍未达成：host-package 已 realpath 找包根，但 runner-capture 决定 bundle/dist 候选顺序时仍用未 realpath 的 argv[1] → 选到未打包类 → 补错类后拒绝启用（Main 已回读核实，两 lane 一致）。
- 其他：新 specifier 兜底无 committed 测试；README:78 与新兜底矛盾；patchInstalled=true 且 captures=0 时 status 仍为成功形状；临时 node_modules 槽位在硬杀场景可能残留（gitignored，不会脏 git 状态但会遮蔽裸 import）。

用户已批准批次 #5（含产品端口修复），范围：绑定时避开/重绑禁用端口并加回归测试；等待失败文案带上 error.cause 且 bad port 快速失败；候选顺序改用 realpath 后的入口 + capture 级 symlink 测试；补 specifier 兜底 committed 测试；README 与 status 措辞修正。

## 批次 #5 定向确认与端口残留

两条只读 lane 均给出：**无本批次引入的 blocker**；重绑/资源/失败语义经真实 socket 验证（显式 6000 招错且不发布 URL、失败后端口可重绑、同一 server 连续 10 次 close→re-listen 无泄漏、token/store 不受影响）。同时确认 flaky 已「统计上消除但非穷举」。

残留 W1（同一缺陷的不完整修复）：静态列表与客户端实际行为不一致。risk lane 直接从本机运行中的 undici 提取出真实 badPorts（82 项），我们的列表为 76 项：**缺 77、113、115、117、4190、6679、10080**，多 138（无害）。Main 已实测 113/115/117 被 Node fetch 拒绕；reviewer 用真实 Chrome 实测确认 **10080** 被浏览器拒绕（ERR_UNSAFE_PORT）。本机 ephemeral 区间 1024–15000 覆盖这些端口，因此仍存在一条窄路径：随机绑定到未收录禁用端口时会发布一个浏览器打不开的 URL（估算约 0.03%/次绑定，且会让套件偶发红）。

其余：新增的 formatErrorWithCause / isNonRetryablePortError 无 committed 测试（改坏后套件仍绿）；test/runner-binding.test.js:759 的负向断言因双反斜杠而永不匹配（无效断言）；README 对「WHATWG 列表」的描述偏乐观；另有两个低风险项（注入 createServer 无 unref、fake node_modules 槽位在硬杀场景可能残留，但跳文件污染已被实测排除）。

用户已批准小批次 #6：补齐端口集合 + **绑定后真实客户端自检**（遇 bad port 则重绑，防未来列表漂移）+ 两条诊断函数单测 + 修正无效断言 + README 口径对齐（另可选修 used source 措辞）。批完即写最终结论、Commit A 与知识收口。

## 最终验收

结论：**已通过（原型级别）——但该私有接缝架构被用户否选，本 change 作为已验证原型与后续复用基线收尾**。

已完成：批次 #1–#7 全部落地，每批均经 Main 回读实际代码与自查命令；两次完整审查加多轮同角色 fallback 定向确认（已标注），均无 blocker；最终 Main 独立复测连续 8 次全量干净（183 tests / 182 pass / 0 fail / 1 opt-in skip），`npm run check` 退出 0。

真实活体验收（真实 TUI 会话 + 真实 Chrome/CDP，非 fake DOM）覆盖全部要求表面：加载与令牌流、状态面板（cwd/main/真实 token 用量）、模型与 thinking 切换且回显实际生效值、多行聊天与真实模型流式回复、停止、未知 slash 拒绝、streaming 时滚动不被拉底、confirm/select/input/editor 在浏览器回答且 custom/questionnaire 明确 unsupported 不挂起、宿主自产 `ui_prompt_start/end` 五类各有配对、子任务面板（fleet-1 opaque key 无 transcript 动作 = key/run id 分离；async 行含真实 `last update` 时间戳，直接证明 updatedAt 修复在真实 owner 下生效；detail 为有界 tail）、浏览器刷新后同一 request id 恢复且历史不重复（35→35）、浏览器发起的真实 `AgentSession.reload`（generation 1→2、URL/token 不变、各面板重绑）、以及安全拒绝（401/400/伪造 Origin 403/Host 403/服务器侧多余字段 400；写操作无 Origin 亦 403）。

残余（均已在证据中量化，不阻塞原型）：POSIX 真实 symlink bin 与 bun/SEA 无活体验证；启动首帧 git 短暂 `not_repo` 后自愈为 main；禁用端口表保留 138（对已装客户端无害）；分类器基于错误文本，未来 undici 改文案会静默降为 inconclusive；子任务面板非空行只用一次真实短任务验证。

**方向变更（用户决定，记入本文件）**：用户指出「GUI 启动后是否与 TUI 同一会话并不重要，重点是日常使用都在 GUI 里」。据此决定改用 Pi **公开 SDK/RPC**（`createAgentSession` + `session.bindExtensions({ uiContext })`，`ExtensionUIContext` 为公开导出）重建 GUI：对话框由我们提供的 UI context 直接转发到浏览器，彻底不再 hook 私有 `setUIContext`。代价：GUI 会话与 TUI 会话是两个会话；收益：不再有接缝捕获/版本指纹/宿主 reload 跟踪/ bundle 与 dist 类身份等脆弱依赖。该重建属**新 change**（新 spec/tasks/evidence）。

因方向变更，批次 #7 的又一轮确认被**有意跳过**（原计划含此轮）：以 Main 自己的 8 次全量复测 + 活体冒烟替代，并在本文件中如实标注；已完成的各批确认仍为有效记录。本 change 不再开新修复轮次，作为已验证原型保留（Commit A），其 UI 层、桥接与安全硬化、测试均为新 change 的复用基线。不 push、不发布、不全局安装。
