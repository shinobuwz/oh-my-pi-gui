# Domain Language

## generation

**Meaning**：一次浏览器桥接绑定的世代号。桥每次 attach/rebind 后递增；页面与请求都带世代，旧世代的操作与回答必须被拒绝。

**Avoid**：不要读成协议版本、Pi/Pi 包版本或会话 ID。

**Relations**：generation 变化时页面重置本地缓存并重新取全量状态。

## fleet key

**Meaning**：pi-subagents fleet 列表里的展示用 opaque key（如 `fleet-1`），只用于显示。

**Avoid**：不要当作 run id 使用；run id 是 async run 的 UUID。

**Relations**：子任务详情只接受当前 generation 内、由成功 status 返回的 async run id；fleet key 永不用于 detail 查询。
