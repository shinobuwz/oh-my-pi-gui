# Pitfall

## 不要这样做

需要 pi-subagents 的结构化检视（`/subagents-inspect-rpc`）时，不要用 `mode: "tui"` 绑定宿主会话。

## 反例

宿主按 tui 绑定（这个模式曾是为让 `ctx.mode !== "tui"` 的扩展如 questionnaire 生效而选的）。此时 inspect 命令的 handler 命中 `if (ctx.mode === "tui") { notify("Inspection replies are emitted only on RPC surfaces."); return; }`：命令**正常返回、没有报错、也没有 widget 载荷**，宿主只能等自己的 5s 期限并报 `inspect_timeout`。现象看起来像扩展坏了或上游没实现，实际是模式不匹配。

## 正例

绑 `mode: "rpc"`：`hasUI()` 只取决于「是否提供了 uiContext」，而 rpc 模式同样具备对话框能力，因此 confirm/select/input/editor 仍落在浏览器（浏览器宿主照样能回答对话框），同时 inspect 命令会真正发出 `ctx.ui.setWidget("subagent-inspect", ["PI_SUBAGENT_INSPECT_JSON:…"])`。必须一并接受并如实呈现的代价：`ctx.mode !== "tui"` 的扩展走非交互分支（例如本地 questionnaire 直接返回 “UI not available (running in non-interactive mode)”）。

## 为什么不行

pi-subagents 用 mode 判断「宿主是不是真终端」，只在非 tui 时认为存在 RPC 表面；这是全包唯一的 mode gate，所以它同时决定了两类能力，不能只取其一。宿主侧的 UI context 能力与 mode 无关，这一点容易误判为「绑 rpc 就没对话框了」。

## 适用前提

本仓库的浏览器宿主（自有会话、浏览器负责对话框），以及任何用 SDK 自建宿主、同时想要对话框与结构化检视的场景。若不需要结构化检视，`tui` 仍能让 tui-gated 扩展保持启用。

## 验证

`node src/host/main.js --url-file <tmp>`（rpc 模式）后 `POST /api/subagents/inspect` 能拿到结构化回复；把 `HOST_UI_MODE` 改回 `"tui"` 则同一请求以 `inspect_timeout` 结束。模式常量在 `src/host/host.js`；相关测试 `test/host-subagents.test.js`、`test/host-ui-context.test.js`、`test/sdk-smoke.test.js`。

## 重审条件

上游放宽该 mode gate，或把 inspect 暴露为事件总线 RPC 方法后，本条降级为「无此限制」（届时 tui 模式也能同时拿到检视能力）。
