# Pitfall

## 不要这样做

不要用 `listen(0)` 分配到的随机端口直接生成对外 URL 并交给浏览器（写 URL 文件、打印、通知都算）。

## 反例

绑定成功后直接用 `server.address().port` 拼 URL。若系统分配到的端口落在客户端禁用集合里（例如 10080、6000、4190），服务端能监听，但 `fetch` 与浏览器会拒绝连接：Node 报 `fetch failed | cause: bad port`，Chrome 报 `ERR_UNSAFE_PORT`——页面打不开且不报错。

## 正例

保留一份与 undici bad-port 集合对齐的静态列表作为快路径；绑定成功后、发布 URL 前再做一次**带超时**的客户端自检（例如 `fetch('http://127.0.0.1:<port>/api/state')`，任意 HTTP 状态都算可达），命中禁用端口就关闭并重绑。

## 为什么不行

禁用端口集合来自客户端而非服务端：undici 与 Chromium 各有实现差异，而本机动态端口区间会覆盖其中一部分，所以随机端口有真实概率落到被拒端口。超时上界必不可少：没有它，被注入/代理型 fetch 会永久挂起启动流程。

## 适用前提

任何要在浏览器里打开的本地 HTTP/HTTPS 服务。若使用固定且已知可用的端口，或只在非浏览器客户端内使用，风险显著降低但不为零。

## 验证

`fetch('http://127.0.0.1:6000/')` → `cause: bad port`；实现与回归测试见 `src/core/bridge-server.js`（`BROWSER_BLOCKED_PORTS`、`runClientSelfCheck`、`CLIENT_SELF_CHECK_TIMEOUT_MS`）与 `test/bridge-server.test.js`。
