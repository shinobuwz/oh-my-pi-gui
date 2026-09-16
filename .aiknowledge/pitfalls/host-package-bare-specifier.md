# Pitfall

## 不要这样做

不要在本仓库（`package.json` 声明 `"type": "module"`）内的普通 `.js` 模块里用裸 specifier 导入已安装的 Pi 宿主包。

## 反例

```js
const mod = await import("@earendil-works/pi-coding-agent");
```

从仓库路径（`E:/gitlab/oh-my-pi-gui/src/...`）执行会得到 `ERR_MODULE_NOT_FOUND`：全局安装的包不在仓库的上游 `node_modules` 里。

## 正例

由运行入口解析宿主包根，再按绝对路径导入 SDK 模块（当前 host：`PI_GUI_SDK_PATH` → `PI_GUI_PACKAGE_ROOT` → 全局 npm 位置 → `npm root -g`，导入 `<pkgRoot>/dist/index.js`），先做存在性检查再导入，并校验导出形状后才使用；裸 specifier 只作为最后的兜底（当前实现干脆不用）。

## 为什么不行

宿主加载扩展时用 jiti；对 `type:module` 包内的 `.js`，jiti 不转译、直接交给 Node 原生 ESM 解析，因此没有 virtual modules 兜底。放在系统临时目录（无 `package.json`）的同样代码反而能被转译——这也是历史测试一直没抓到这个缺陷的原因（探针写进了 `mkdtempSync()` 目录）。

## 适用前提

任何在本仓库内需要打开 Pi 宿主模块的代码：适配器、探针、测试 fixture。若代码位于没有 `package.json` 的临时目录，或宿主提供方明确注入了模块，则不适用。

## 验证

从仓库内文件 import 会失败、按绝对路径导入会成功。当前回归测试：`test/host-sdk-loader.test.js`（解析顺序、显式 override 失败即拒、导出形状检查）。
