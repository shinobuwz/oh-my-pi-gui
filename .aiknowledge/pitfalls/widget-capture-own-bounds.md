# Pitfall

## 不要这样做

不要用 UI context 里**通用 widget 面板**的上限与 retract 语义去承载需要完整取回的载荷（例如 pi-subagents 的 inspect 回复）。

## 反例

通用路径把 widget 每行按 `bounded(line, MAX_MESSAGE_CHARS)`（当前 4000 字）存进可见 pane。inspect 回复是**单行** JSON，上游自己只保证 ≤64KB——走通用路径时这行被静默截断成非法 JSON，`JSON.parse` 失败，表现为「上游明明回了东西却解析不出来」。第二个坑是生命周期：上游用 emit-then-retract 发送（`setWidget(key, payload)` 后立刻 `setWidget(key, undefined)`），如果 retract 顺手把捕获也清掉，载荷在关联之前就没了。

## 正例

为这类键开**专用捕获路径**：单行上限不低于载荷上限（我们取 80KB），**retract 只清可见 pane、不清捕获**；捕获按 key 有界（条数 + 总字符，超出丢最老），并暴露一个可单测的读取/订阅接缝（`onWidgetUpdate` / 按 key 取最近一次原始行）。可见 pane 的通用上限保持不变。

## 为什么不行

「可见 pane」与「取回载荷」是两个用例：前者按可读性截断是合理的，后者必须完整且能按 `requestId` 关联。共用一个上限时，截断恰好发生在需要完整性的那一侧，而且失败是静默的——没有异常，只有解析失败或超时。

## 适用前提

任何从 `ExtensionUIContext.setWidget` 取回结构化数据的接缝（当前是 pi-subagents inspect；同类上游若改用 widget 通信同样适用）。只用于显示、无需完整取回的 widget 不受影响。

## 验证

`src/host/ui-context.js`（`MAX_INSPECT_WIDGET_CHARS`、widget capture 与 retract 语义）、`src/core/inspect-reply.js`（解析 + 二次有界投影）；测试 `test/host-ui-context.test.js`、`test/inspect-reply.test.js`。

## 重审条件

`ui-context` 的通用上限、或者 `setWidget` 的 retract/捕获语义改变时重审。
