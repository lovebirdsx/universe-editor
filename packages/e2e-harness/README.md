# @universe-editor/e2e-harness

Universe Editor 的 Playwright e2e 测试工具包：fixture 工厂（冷启动 / 共享实例）、页面对象（Workbench / ActivityBar / SideBar / StatusBar / QuickInput / EditorArea / Panel / AcpTimeline）与 launch 辅助（`resolveEditorLaunchTarget` / `launchApp` / `launchAppReady`），用于对 Universe Editor 跑端到端测试。

## 安装

```bash
npm install --save-dev @universe-editor/e2e-harness @playwright/test
```

`@playwright/test` 是本包的 **peerDependency**：消费方必须显式安装与本包同区间的 `@playwright/test`（当前 `^1.62.0`）。**红线：整个依赖树只能有一份 `@playwright/test` 物理拷贝**——harness 复用 Playwright 的 `test` / `expect` / `_electron` 运行时，两份拷贝会各自维护一份 worker/进程表，启动即崩。若 `pnpm why @playwright/test`（或 `npm ls @playwright/test`）出现两份，请把消费方的 `@playwright/test` 对齐到同一版本区间。

## 编辑器定位（env 契约）

harness 通过 `UNIVERSE_EDITOR_BIN` 环境变量决定启动哪个编辑器，三种形态：

| `UNIVERSE_EDITOR_BIN` | 形态 |
|---|---|
| 可执行文件（如 Windows 安装版 `Universe Editor.exe` / `linux-unpacked` 可执行文件） | packaged：直接启动打包版 |
| 以 `.js` 结尾（dev 产物 `apps/editor/out/main/index.js`） | dev：以 `mainEntry` + 就近解析的 electron 二进制启动 |
| electron 二进制 + 同时设 `UNIVERSE_EDITOR_MAIN_ENTRY`（`out/main/index.js`） | dev-bundle：显式指定 electron 二进制与 main entry |

未设置时：win32 自动探测 `%LOCALAPPDATA%\Programs\Universe Editor\Universe Editor.exe`，再回退到仓库内 dev 产物（`resolveEditorBuild`）。

## 版本约定

harness 的 minor 版本**跟随编辑器 minor**（契约随编辑器演进）；升级编辑器时请同步升级 harness 与 e2e-contract。

## License

Apache-2.0
