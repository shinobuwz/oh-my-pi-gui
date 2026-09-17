# Domain Language

## generation

**Meaning**：一次浏览器桥接绑定的世代号；页面与请求都带世代，旧世代的请求与回答一律被拒绝。当前 host 每进程只创建一个会话、固定 `generation = 1`（in-place reload 被拒绝），递增路径仅保留在请求层以备会话重建。

**Avoid**：不要读成协议版本、Pi/Pi 包版本或会话 ID。

**Relations**：generation 变化时页面重置本地缓存并重新取全量状态。

## fleet key

**Meaning**：pi-subagents fleet 列表里的展示用 opaque key（如 `fleet-1`），只用于显示。

**Avoid**：不要当作 run id 使用；run id 是 async run 的 UUID。

**Relations**：子任务详情（artifact 文本尾部）只接受当前 generation 内、由成功 status 返回的 async run id；结构化检视还额外接受聊天行上报过的 id（见 referenced async id）。fleet key 永不用于 detail/inspect 查询。

## referenced async id

**Meaning**：由宿主的聊天投影从 `subagent` 工具结果里取出的 async run id（`details.asyncId`，workflow 为 `runId`），用来让聊天行也能请求结构化检视。它与「状态快照保留的 async run id」是两个来源，检视路由两者都接受，但两者都必须是**宿主上报过**的 id。

**Avoid**：不要理解为「任意外部 run id 都可查」，也不要当作 fleet key 使用；它只为已经出现在本会话 UI 里的 run 服务。

**Relations**：有界（64 条 FIFO）、只接受不透明 id 形状；不因离开状态快照而失效；`details.asyncDir` 等路径字段永不投影到浏览器。上游解析失败时检视路由会追问一次 `status` 转写，所以同一个 id 可能答结构化视图，也可能答 `{kind:"transcript"}`（见 foreground run）。

## foreground run

**Meaning**：由 `subagent` 工具**阻塞**派发的子代理运行（single/parallel/chain）。它不在 async 快照里，pi-subagents 的 `/subagents-inspect-rpc` 按设计拒绝它（回 `not_found`），但它的 `status` 动作可以答：运行中给 live foreground 转写，结束且仍在内存时给状态/子节点/结果尾部文本。

**Avoid**：不要把它当 async run——async 快照为空、fleet DTO 没有 `state`/`role` 字段都是正常的，不代表面板坏了；也不要用 fleet 展示 key 去查它（那永远是纯展示值）。

**Relations**：run id 随**工具结果**（`details.runId`）才到页面，所以运行中的前台子代理无法被命名/观看，只有跑完后的聊天行能进去；Inspect 先拿 `status` 转写，再由宿主按 parent `.jsonl` 派生 `<parent session id>/<runId>/run-0/session.jsonl`，有文件时补全 thinking/tool arguments/results。页面当前只请求 index 0；alternate `sessionDir`、其它 child index 和 Pi 重启后的上游 allow-list 遗失都如实返回 unavailable/not_found，不扫描、不猜路径。
