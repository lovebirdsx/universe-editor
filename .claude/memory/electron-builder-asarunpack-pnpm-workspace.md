---
name: electron-builder-asarunpack-pnpm-workspace
description: apps/editor 的 platform/workbench-ui 必须放 devDependencies——否则 electron-builder asarUnpack 打包崩
metadata: 
  node_type: memory
  type: project
  originSessionId: 41bab4d7-386e-4d58-9bc9-6db73a2fc5d5
---

`apps/editor/package.json` 里 `@universe-editor/platform` 和 `@universe-editor/workbench-ui` 必须在
**devDependencies**(不是 dependencies),不要"修正"移回 dependencies。

**Why:** 引入原生模块 `@parcel/watcher` 后,electron-builder.yml 用了 `asarUnpack` 解包它的 `.node`。
开启 asarUnpack 后,electron-builder 对每个被收集文件调 `getRelativePath`(app-builder-lib `util/filter.ts`):
若文件 realpath 不在 app 目录下,就找路径里的 `/node_modules/` 子串——找不到就 throw
`<file> must be under <appDir>`。pnpm 普通依赖(含 @parcel/watcher)的 realpath 在
`node_modules/.pnpm/.../node_modules/...`,含 `/node_modules/`,能正常处理;但 workspace 包是 symlink 指向
`packages/platform`,realpath 是 `packages/platform/CLAUDE.md` 这类**不含** `/node_modules/` 的路径 → throw。
而这两个 workspace 包的代码已被 electron-vite **bundle 进 `out/`**(main 的 externalizeDeps 显式 exclude
platform、renderer 同理),运行时根本不需要其 node_modules 副本。放 devDependencies 后 electron-builder
只收集 production deps,不再遍历它们的外部 realpath,打包通过。pnpm 对 workspace devDep 仍建 symlink,
所以 tsc/eslint/vite/turbo 全部不受影响。

**How to apply:** 改 apps/editor 依赖时保持这两个在 devDependencies。新增其它 workspace 包依赖(被 bundle 的)
也应放 devDependencies。新增**原生**npm 依赖时,在 electron-builder.yml 的 `asarUnpack` 加它的
`**/node_modules/<pkg>/**` 并设 `npmRebuild: false`(@parcel/watcher 是 prebuilt N-API,无需重编)。

**打包可本机验证**(与 [[e2e-electron-launch-broken-local]] 不同):
`pnpm --filter "@universe-editor/editor..." build` 后 `cd apps/editor && pnpm exec electron-builder --win dir`,
检查 `release/win-unpacked/resources/app.asar.unpacked/**/*.node` 存在。
