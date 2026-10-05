# packages/extension-api/CLAUDE.md

扩展作者编程所依赖的 API 表面（Universe 版 `vscode.d.ts`，发布为 `@universe-editor/extension-api`）。本包只出**类型与门面**，实现在宿主侧（`packages/extension-host`）与 renderer 侧（`apps/editor/src/renderer/services/extensions/MainThread*`）。版本承诺与破坏性变更流程的单一真相在 [COMPATIBILITY.md](COMPATIBILITY.md)（`src/__tests__/index.test.ts` 是 API 表面快照）；0.13.0 语言/主题/菜单面补全的实现落点与坑见 [cases-surface-implementation.md](cases-surface-implementation.md)。

## 版本契约

- **版本号 = 编辑器 App 版本**（单一版本空间，对齐 VSCode 的 product version 即 API 版本）。bump 三件套：`src/index.ts` 的 `version` 常量 + `package.json` 的 version + COMPATIBILITY.md 追加变更记录；随后 `pnpm ext-packages:gen` 物化 uex / create-extension 内嵌的版本常量（生成物，勿手改），发布 preflight 有一致性拦截、版本耦合检查拦漏发。内置扩展的 `engines.universe` 同步 bump（`pnpm builtin-engines:fix`，守卫 `scripts/check-builtin-extensions-engines.mjs`）。
- **`export const version` 是打包期常量**（本 SDK 编译目标的编辑器版本，类比 `@types/vscode`）：扩展运行时读宿主真实版本用 `env.appVersion`。**勿改成 lazy getter**——ESM 顶层 const 做不了 getter，host 外会炸。
- **0.x 不建 proposed API 机制**：1.0 之前 minor 即可携带破坏性变更，靠契约快照 + `version` bump + COMPATIBILITY 记录把关，不引入 proposed 通道（详见 COMPATIBILITY.md 与 `docs/extension-dev/zh-CN/versioning.md`）。

## 加一个 API 面的五层落点

1. **本包 `src/index.ts`**：加 namespace / 类型。**enum 一律普通 enum 非 const enum**（扩展 tsconfig 开 `isolatedModules`，跨模块 const enum 报 TS2748）。
2. **wire 契约** `packages/extensions-common/src/protocol/rpc.ts`：通道名 + `IExtHost*` / `IMainThread*` 接口 + wire DTO（必须可结构化克隆）。
3. **host 实现** `packages/extension-host/src/`：`apiFactory.ts` 的 bridge 加方法、`extensionService.ts` 实现、`bootstrap.ts` 注册通道。
4. **renderer 实现** `apps/editor/src/renderer/services/extensions/`：`MainThread*.ts` + `HostConnection.ts` 注册（无条件注册）。
5. 重建 dist：`pnpm --filter @universe-editor/extensions-common --filter @universe-editor/extension-host build`（dev watcher 自动）。

注入方式：**宿主注入的 globalThis bridge（`__universeExtensionHostBridge__`）**——**不做 ESM loader hook、不做 vscode shim**。逐层套路见 `packages/extension-host/CLAUDE.md`「加一条 MainThread*/ExtHost* 通道」。

## main 侧取 App 版本一律用 getAppVersion()

**main 侧新代码取 App 版本一律用 `apps/editor/src/main/appVersion.ts` 的 `getAppVersion()`**，勿直调 `app.getVersion()`。大坑（已根治）：非打包启动（dev/e2e 的 `electron out/main/index.js`）下 `app.getVersion()` 返回 **Electron 自身版本**，曾致内置扩展按 `^0.13.0` 全量误禁用；`getAppVersion()` = `app.isPackaged ? app.getVersion() : __APP_VERSION__`，`__APP_VERSION__` 由 electron-vite main 段 `define` 注入（vitest main project 同步 define）。e2e 守卫：内置扩展不得出现在 `getVersionIncompatibleExtensionIds()`。

## 验证

`pnpm --filter @universe-editor/extension-api test`（契约快照 + URI / RelativePattern / workspacePaths 表）；改表面后补跑 `pnpm builtin-engines:check`。对外发布流程见 `docs/development/publishing-sdk.md`。
