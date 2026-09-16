# Surface Index

| State | Read when | Target |
|---|---|---|
| active | 需要把浏览器/GUI 接到一个活 Pi 会话的对话框或事件上，或打算 hook Pi 内部接缝时 | [不要 hook 私有 UI 接缝去接管活会话对话框](private-ui-seam-capture.md) |
| active | 在本仓库（type:module 包）内需要 import 已安装的 pi 宿主包时 | [本仓库内不要用裸 specifier 导入宿主包](host-package-bare-specifier.md) |
| active | 在本机监听随机端口并把 URL 交给浏览器（或写进文件/日志）时 | [不要把随机端口直接当对外 URL 发布](browser-blocked-ports.md) |
| active | 用 pi-subagents 派发工作流、且任务文本里含代码片段/路径/命令时 | [workflowScript 里不要用反引号](pi-subagents-workflow-backticks.md) |
| active | 要给浏览器宿主接上 pi-subagents 的结构化检视，或调整 `bindExtensions` 的 mode 时 | [需要结构化检视时不要用 mode: tui 绑定宿主](subagent-inspect-requires-rpc-mode.md) |
| active | 要从 `ExtensionUIContext.setWidget` 取回需要完整使用的数据时 | [不要用通用 widget 上限与 retract 语义承载待取回的载荷](widget-capture-own-bounds.md) |
| active | 某个 surface 会周期性重建，而它与其他 surface 共享 DOM/状态注册表时 | [周期性重建的 surface 不要清理共享注册表](periodic-rebuild-owns-its-key-space.md) |
