---
name: extension-editor-version-contract
description: 插件↔编辑器版本依赖契约——版本空间统一 0.13.0 + engines.universe 校验闭环(禁用+通知/市场选版/发布拦截)
metadata: 
  node_type: memory
  type: project
  originSessionId: fda7c259-b4eb-41c9-b9ed-30d54bc45221
  modified: 2026-08-19T17:34:13.535Z
---

# 插件↔编辑器版本依赖契约(2026-08-20 落地)

版本空间统一为 App 版本(对齐 VSCode product version 即 API 版本):App 0.1.71 与 extension-api 0.12.1 共同跳到 **0.13.0**(保 npm 与自动更新双单调)。此后 App 发版 patch 递增,API 面变更 minor 递增;`release.mjs` 的 `syncVersionSpace` 同步 extension-api pkg + `index.ts` version 常量 + sdkVersions 生成物 + builtin engines fix,锁步由 uex `sdkVersion.test.ts` 双断言守护。

关键契约:
- `engines.universe` = **编辑器版本**区间(必填);宿主校验版本经 spawn env `UNIVERSE_APP_VERSION` 传入(本地/远程两条链),bootstrap 缺省 fail-open。
- `extension-api` 的 `export const version` = 打包期常量(SDK 编译目标,类比 @types/vscode);运行时宿主版本用 `env.appVersion`。**勿改 lazy getter**(ESM 顶层 const 不可 getter,host 外会炸)。
- 不兼容扩展:scanner 返回 `isValid:false+validationMessage`(不再 throw-skip),activation filter 排除 active、deduped 保留供可见;UI 显示「已禁用(需要 universe X,当前 Y)」+ 一次性通知(内存 Set 去重)。builtin/dev 不豁免。
- 市场:`IGalleryExtension.versions[]` + `pickCompatibleVersion`(从新到旧首个 satisfies,缺 engine fail-open);installFromGallery 窄化 `target` 条目让下载/防投毒/验签全走选中版本;checkForUpdates 只推兼容新版。服务端零改动(多版本响应早已支持)。
- 发布:uex coverage error + `--force`(按 check code 降级仅这一条);服务端 `metadataFromManifest` 拒 `||`/hyphen range(与客户端 semver fail-closed 同源,正则复制注明同步义务)。
- 推荐 range:第三方 `">=0.13.0 <1.0.0"`(勿 `^`,0.x caret 挡兼容 minor);内置 `^X.Y.0` 由 `scripts/check-builtin-extensions-engines.mjs`(`pnpm builtin-engines:check/fix`,已入 check 链)守卫。

**大坑(已根治)**:非打包启动(`electron out/main/index.js`,dev/e2e 均是)下 `app.getVersion()` 返回 **Electron 自身版本 43.3.0**——曾致 dev/e2e 宿主版本错误、内置扩展 `^0.13.0` 全量误禁用。修复=electron-vite main 段 `define` 注入 `__APP_VERSION__` + `src/main/appVersion.ts` 的 `getAppVersion()`(`app.isPackaged ? app.getVersion() : __APP_VERSION__`),main 全部 12 处调用点收口;vitest main project 同步 define;e2e 守卫=内置扩展不得出现在 `getVersionIncompatibleExtensionIds()`。**main 侧新代码取 App 版本一律用 `getAppVersion()`,勿再直调 `app.getVersion()`**。

相关:[[extension-system-progress]] [[extension-api-09-surface-expansion]] [[third-party-extension-ecosystem-plan]]
