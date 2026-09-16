# Pitfall

## 不要这样做

不要通过 hook Pi 的私有 UI 接缝（捕获 `ExtensionRunner` 实例、给 `prototype.setUIContext` 打补丁、再 rebind）来接管活会话的对话框。

## 反例

`src/adapter/runner-capture.js` + `src/adapter/ui-adapter.js` 的实现路径（已随私有接缝路线从工作树删除，代码保留在 git 历史/Commit A = `0959a48`）：工厂期补丁 `ExtensionRunner.prototype.setUIContext` → session_start 时用捕获到的 runner rebind 一个桥接 UI context。真实 TUI 下该路径失败过多次（capture never observed、包根解析失败、symlink 下选到未打包类）。

## 正例

用公开 SDK：`createAgentSession(...)` 拿到 `session`，再 `session.bindExtensions({ uiContext: <自己的 ExtensionUIContext>, mode })` 把对话框/状态直接接到自己的 UI 上；`uiContext` 与 `ExtensionUIContext` 都属于公开 API（`ExtensionBindings` 字段与公开类型）。

## 为什么不行

接缝不公开且随小版本漂移；需要精确的类身份（bundle 类与 dist 类是**不同对象**，补错一份就永远捕获不到）；仓库是 `type:module` 时宿主加载器不转译该模块图，裸 specifier 解析会失败；还必须追宿主的 attach/detach/reload 生命周期。真实成本见 `openspec/changes/browser-interaction-spike/evidence.md`（批次 #3–#7）。

## 适用前提

当目标是把浏览器/GUI 接到「Pi 会话的对话框与事件」时，先查公开 API；只有在公开 API 确实缺失、且明确接受版本锁定与升级维护成本时，才考虑私有接缝。

## 验证

真实会话启动后能从浏览器打开 URL 并回答 confirm/select；不再依赖任何 capture 状态（当前验证：`npm test` 的 host 套件、`PI_GUI_SMOKE=1 node --test test/sdk-smoke.test.js`）。公开 API 位置：`dist/core/sdk.d.ts`（`createAgentSession`）、`dist/core/agent-session.d.ts`（`ExtensionBindings.uiContext`、`bindExtensions`）。

## 重审条件

Pi 若为浏览器/外部 UI 提供稳定的公开附着 API（例如直接暴露活会话的能力），应重新评估本节结论。
