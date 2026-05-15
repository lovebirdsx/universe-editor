# CLAUDE.md

VSCode 范式的桌面游戏内容编辑器。

## 仓库布局

pnpm workspace + Turborepo 的 monorepo，全部 ESM (`"type": "module"`)。

```
apps/
  api/      Hono + Node（开发用 tsx watch）
  web/      Vite + React 19
  editor/   Electron 33 + electron-vite（main/preload/renderer/shared 三端一体）
packages/
  shared/         纯工具函数 → dist/
  ui/             React 组件库 → dist/
  platform/       VSCode 风格内核：DI / Lifecycle / Command / Configuration / IPC / Workbench services
  config-ts/      共享 tsconfig 预设（base / react / node）
  config-eslint/  共享 ESLint flat config（base / react）
```

## 常用命令

```bash
pnpm dev          # 启动所有 dev（shared/ui/platform 先 watch 构建）
pnpm check        # lint + typecheck + test + build（提交前跑这个）
pnpm lint:fix     # 自动修复格式 + lint

pnpm --filter @universe-editor/editor dev   # 只启动桌面编辑器
pnpm --filter @universe-editor/platform test
```

## 必读约定

**包依赖传递**：修改 `shared` / `ui` / `platform` 后，apps 看到的是 `dist/`。`pnpm dev` 下 watcher 会自动重建；离开 dev 模式时手动 `pnpm build` 或 `pnpm --filter <pkg> build`，否则 apps 仍使用旧产物。

**TS 严格性**：开启 `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。这意味着：
- 数组/对象索引返回 `T | undefined`，必须显式处理
- 可选属性写 `prop?: T`（而不是 `prop: T | undefined`），二者不可互换

**测试**：测试文件位于 `src/__tests__/`，命名 `*.test.ts(x)`。环境：
- API / platform / 主进程 → node
- web / ui / renderer → happy-dom + `@testing-library/react`
- `apps/editor` 用 vitest `test.projects` 同时跑 main（node）和 renderer（happy-dom）

**Electron 三端边界**（`apps/editor`）：
- `src/main/`：业务逻辑从 `ipc.ts` 抽到独立文件，便于不依赖 Electron 单测
- `src/preload/`：仅通过 `contextBridge.exposeInMainWorld` 暴露白名单 API
- `src/renderer/`：通过 `window.api` 调用主进程，类型在 `global.d.ts`
- `src/shared/`：IPC 通道名常量（`ipc-channels.ts`）+ 消息类型
- 产物在 `out/{main,preload,renderer}`（electron-vite 约定，勿改）

**Platform 公共导出**：所有对外 API 走 `packages/platform/src/index.ts`，新增模块需在此 re-export。

**版本管理**：依赖版本统一在 `pnpm-workspace.yaml` 的 `catalog:` 下，包内 `package.json` 写 `"catalog:"` 而非具体版本号。

## 代码风格

Prettier：无分号、单引号、`trailingComma: all`、宽度 100。

## CI

`.github/workflows/ci.yml` 在 push/PR 到 `main` 时按顺序跑 `lint → typecheck → test → build`。CI 设置了 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，`pnpm-workspace.yaml` 的 `allowBuilds` 显式允许 `electron` / `esbuild` 的 install hook（pnpm 10 默认拒绝）。
