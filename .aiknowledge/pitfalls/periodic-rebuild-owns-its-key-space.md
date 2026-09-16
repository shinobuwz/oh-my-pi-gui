# Pitfall

## 不要这样做

**周期性重建的 surface**（本仓库的 rail：每个子任务状态快照都整体重建）不要在重建时无差别清空或剪枝**共享**的 DOM/状态注册表。

## 反例

rail 每轮 `state.subagentInspectNodes.clear()` 并按活跃 run id 剪枝 `state.subagentInspects`。这在「只有 rail 渲染结构化面板」时是正确的，但聊天行里的面板不在这一轮重建范围内：子代理完成、run 离开有界状态快照后，聊天面板的节点注册与 entry 被删掉，宿主随后返回的答案走到 `if (!current) return;` 被静默丢弃——面板永久停在 “Requesting the structured view…”，对用户表现为「点了没反应」，而网络层其实是 200/16ms 正常返回。

## 正例

给每类入口一个 **key 空间**（rail `run:`、聊天行 `chat:`），周期性重建只清理/剪枝自己那一段；异步结果到达时若 entry 已不存在，就**重建 entry（保持展开）并渲染结果**，而不是直接 return。诊断同类问题时，测量脚本不要抓着 DOM 引用不放：重建会替换节点，读到的是 detached 节点的陈旧文本。

## 为什么不行

重建者只知道自己的生命周期，不知道别人的等待状态；清理共享注册表会把「另一个 surface 仍在等待的异步结果」一并删掉，并且失败完全静默（无异常、无日志、只有一个永远 loading 的面板）。

## 适用前提

任何「一份状态被多个 surface 共享，且其中某个 surface 会周期性重建」的场景；本仓库里 rail（每次状态快照）与聊天行（每次 revision）就是这种组合。

## 验证

`test/subagents-page.test.js` 的 “repaints a chat structured view after the next poll rebuilt the rail”；实现见 `src/browser/app.js`（`RAIL_INSPECT_KEY_PREFIX` / `CHAT_INSPECT_KEY_PREFIX`、`inspectEntry(key, runId, { open: true })` 重建路径）。真实复现：在 GUI 会话里让模型起一个后台子代理，等它完成后点聊天行的结构化入口。
