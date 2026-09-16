# Pitfall

## 不要这样做

不要在 pi-subagents 的 `workflowScript` / `workflowScriptPath` 内容里使用反引号——包括用来标注代码、路径或命令的**行内反引号**（例如想写「调用 `/api/reload` 会拒绝」这种句子时）。

## 反例

在 workflow 脚本的模板串里写：

```
- `/api/reload` 明确返回 501
```

反引号会提前闭合外层模板串，后续内容被解析成 `… / api / reload …`，派发时抛出 `ReferenceError: api is not defined`（或直接语法错误），整个 workflow 不会创建任何 child。

## 正例

- 用单引号或中文引号代替：调用 '/api/reload' 会拒绝；
- 或把任务文本写成字符串数组再 `join("\n")`，需要字面反引号时显式转义；
- 派发**前**先跑 `subagent({ action: "validate", workflowScriptPath | workflowScript })`，它会在启动前捕获这类错误。

## 为什么不行

pi-subagents 把 workflow 内容当作 JavaScript 语句体解析并执行，反引号是模板字符串定界符，任何内层反引号都会截断字符串。

## 适用前提

任何用 pi-subagents 派发、且任务文本里含代码片段、路径、命令或 Markdown 行内代码的编排（本仓库的开发流程就是用 pi-subagents 驱动，因此几乎每次派单都适用）。

## 验证

`validate` 返回 `{ ok: true, errors: [] }`；派发后确认 run 真的创建了 child（`subagent({ action: "status", id })`）而不是立刻失败。
