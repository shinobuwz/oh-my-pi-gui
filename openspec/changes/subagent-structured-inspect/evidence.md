# Evidence：子代理结构化检视（宿主 inspect 通道）

本文件记录本 change 的实际验证结果与残余。契约见 [spec.md](spec.md)，任务与实施记录见 [tasks.md](tasks.md)。

## 路线

用户裁决走宿主侧路线（不先等上游）：`session.bindExtensions({ uiContext, mode: "rpc" })`，据此解锁 pi-subagents 的宿主 inspect 命令 `/subagents-inspect-rpc`，把结构化结果接进页面。已知并接受的代价（`ctx.mode !== "tui"` 的扩展降级）见 spec。

## 已验证（全部为实际运行结果，非推断）

### 上游事实（查源码核实，pi 0.85.1 / pi-subagents 0.67.0）

| 结论 | 依据 |
|---|---|
| `prompt()` 先执行扩展命令并直接返回（无模型回合、不写会话历史） | `dist/core/agent-session.js:826-834`、`:954` |
| `hasUI()` 只取决于是否提供 uiContext，与 mode 无关 | `dist/core/extensions/runner.js:318` |
| rpc 模式同样具备对话框能力 | `dist/core/extensions/types.d.ts:208-214` |
| inspect 命令唯一的 mode gate 在 handler 内（`ctx.mode === "tui"` 时拒绝发出） | `pi-subagents/src/slash/slash-commands.ts:929-940` |
| inspect 回复结构与上限（≤200 条信息、单条 ≤1000 字、task ≤2000、finalOutput ≤8000、总 ≤64KB、超限从最老丢弃并标 truncated） | `pi-subagents/src/runs/background/inspect-rpc.ts` |

### 单元与宿主测试

- `npm test`：**270 tests / 267 pass / 0 fail / 3 opt-in skip**；`npm run check` exit 0。
- 第三个 skip 是新增的 opt-in SDK smoke（`PI_GUI_SMOKE=1` 才跑），非既有覆盖削弱；无新增 `only`/`skip` 于既有测试，无 TODO/占位实现。
- `src/core/redaction.js` 是从旧 `subagents-rpc.js` **逐字提取**（正则、替换语义未变），既有脱敏测试全部继续通过。

### 真实 host 端到端（探针扩展经 `PI_GUI_EXTRA_EXTENSIONS` 注入，用 pi-subagents 自身 RPC 起真实子任务）

| 表面 | 结果 |
|---|---|
| rpc 模式对话框回归 | ✅ 探针 `ctx.ui.confirm` 落到页面 pending，经 `POST /api/answer` 回答 `true`，扩展收到 `{ value: true }`；探针日志 `mode=rpc hasUI=true` |
| 文本型子任务 | ✅ `task` ＝子代理首条 user 消息、`messages` ＝ user+assistant、`finalOutput`="OK"、`status: complete`、`truncated` 全 false、payload 无宿主路径 |
| 使用工具的子任务 | ✅ `messages` 依次 `text`(task) → `toolCall`(`name: "bash"`) → `toolResult`("structured-probe") → `text`("DONE")；`finalOutput`="DONE" |
| 子节点定向 | ✅ `childId: "step:0"` → 200 且回显 childId |
| 运行中检视 | ✅ 200、`status: "running"`、messages 为空（诚实空态，不挂起、不干扰运行） |
| 负例与安全 | ✅ 未知 id 404 `not_found`；多余字段 400；`lines` 非法 400；stale generation 409；伪造 Origin 403；缺令牌 401；响应无宿主路径 |
| 人工核对的项目 | ✅ `setWidget` 通用 4000 字上限不会截断 64KB payload（inspect 键专用 80KB 捕获）；retract 不丢捕获；`prompt()` 命令路径不产生聊天行 |

### 真实浏览器验收（headless Chrome + CDP，真实 host + 真实子任务 + 页面自身动作）

| 表面 | 结果 |
|---|---|
| 页面出现真实 async run | ✅ rail 的 Async runs 出现该 run，settle 为 `state: complete` |
| 页面自身请求 | ✅ 点击「Structured view」恰好 1 次 `POST /api/subagents/inspect`，body `{"generation":1,"id":"1cb0c3c4-…"}`；收起不重发；重开恰好 1 次新快照 |
| 渲染真实数据 | ✅ 面板显示 `status/label`、TASK、Messages（kind 序列 `text / toolCall / toolResult / text`，含 `assistant · tool call: bash`、`structured-probe`、`DONE`）、Final output `DONE` |
| 纯文本保证 | ✅ 面板内 `script` 元素数 0；markup 形态的文本只作为文本显示 |
| 布局 | ✅ 页面 `scrollWidth-clientWidth = 0`、面板自身无横向溢出、与 chat / composer 无矩形交叠；面板 `role="region"`、`tabIndex=0` 可键盘滚动 |
| 主次路径 | ✅ 结构化视图为 `primary` 按钮，「View transcript」保持可用但降为次要（fallback），卡内一行 dim 说明两者差别 |
| 无 id 子节点 | ✅ 只显示不可用原因，不建面板、不发请求、不猜 id（页面测试覆盖） |

### 页面测试（fake DOM）

`test/subagents-page.test.js` 新增 6 个测试：成功载荷（toolCall/toolResult/isError）、三条截断提示、错误码文案互不相同（timeout/busy/unavailable/foreign_session）、running 空态、有/无 id 子节点、默认不发请求 + 点击才发 + 轮询重建不重发 + 重开取新快照。

## 残余（如实登记，不在本 change 修复）

1. **工具参数预览缺失**：活体 `toolCall` 的文本只有 `[tool: bash]`。pi-subagents 的 `sessionMessageParts` 只在 `entry.args !== undefined` 时附带参数预览，而当前 Pi 会话记录的 toolCall part 不带该字段。属上游投影限制，宿主如实透传；要拿到需要上游适配（可作为后续需求提出）。
2. **thinking 原文不可得**：inspect 的 message kind 只有 `text` / `toolCall` / `toolResult`。
3. **有界视图**：信息 ≤200 条、单条 ≤1000 字、task ≤2000、finalOutput ≤8000、总 ≤64KB；超限从最老丢弃并显示截断提示（页面已提示，不静默）。
4. **运行中检视可能为空**：子代理会话文件尚未可读时返回 0 条消息，页面按正常空态渲染（不是错误）。
5. **rail 窄宽可读性**：≥1100px 时 rail 约 300px，长 token 会按 `overflow-wrap: anywhere` 断开（无横向滚动，但阅读性一般）；未改 `--rail-w`。
6. **未验证**：POSIX 平台、非 Chrome 浏览器、以及 `PI_SUBAGENT_CHILD=1` 情况下（pi-subagents 跳过父侧注册）的 inspect 行为。
7. **mode 变更的兼容面**：`ctx.mode !== "tui"` 的扩展降级（questionnaire、llama）；宿主如实呈现其失败文案，不挂起、不傀儡化。真实 questionnaire 交互仅经单元测试覆盖，未做活体点击验证。

## 知识收口（待办）

工作组 7.3 的有界知识维护尚未执行（需按知识契约走正式收口）：候选条目至少包括「宿主若需要结构化检视必须绑 `rpc` 模式，代价是 tui-gated 扩展降级」与「inspect payload 是单行 64KB，不能走 4000 字通用 widget 截断」。
