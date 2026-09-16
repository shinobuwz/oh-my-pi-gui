# Domain Language

## generation

**Meaning**：一次浏览器桥接绑定的世代号；页面与请求都带世代，旧世代的请求与回答一律被拒绝。当前 host 每进程只创建一个会话、固定 `generation = 1`（in-place reload 被拒绝），递增路径仅保留在请求层以备会话重建。

**Avoid**：不要读成协议版本、Pi/Pi 包版本或会话 ID。

**Relations**：generation 变化时页面重置本地缓存并重新取全量状态。

## fleet key

**Meaning**：pi-subagents fleet 列表里的展示用 opaque key（如 `fleet-1`），只用于显示。

**Avoid**：不要当作 run id 使用；run id 是 async run 的 UUID。

**Relations**：子任务详情只接受当前 generation 内、由成功 status 返回的 async run id；fleet key 永不用于 detail 查询。
