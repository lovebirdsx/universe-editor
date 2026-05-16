# CLAUDE.md

VSCode 范式的桌面游戏内容编辑器。本仓库通过分层 CLAUDE.md 指导：根文件做**导航 + 跨包共同约定**；进入子目录后请优先阅读该目录的 CLAUDE.md。

## 仓库布局

pnpm workspace + Turborepo 的 monorepo，全部 ESM (`"type": "module"`)。

```
apps/
  api/      Hono + Node（开发用 tsx watch）          → apps/api/CLAUDE.md
  web/      Vite + React 19                          → apps/web/CLAUDE.md
  editor/   Electron 33 + electron-vite              → apps/editor/CLAUDE.md
packages/
  shared/         纯工具函数 → dist/                 → packages/shared/CLAUDE.md
  ui/             React 组件库 → dist/               → packages/ui/CLAUDE.md
  platform/       VSCode 风格内核                    → packages/platform/CLAUDE.md
  config-ts/      共享 tsconfig 预设                 → packages/config-ts/CLAUDE.md
  config-eslint/  共享 ESLint flat config            → packages/config-eslint/CLAUDE.md
```

## 导航表

| 你想做什么 | 主战场目录 | 必读 CLAUDE.md | 关键约定 |
|---|---|---|---|
| 加桌面端命令 / 快捷键 | `apps/editor/src/renderer/actions/` | `apps/editor/CLAUDE.md`（套路 A） | Action2 + `registerAction2`，在 `actions/index.ts` 注册 |
| 加 ViewContainer / View（侧栏标签页） | `apps/editor/src/renderer/contributions/` + `workbench/sidebar/SideBar.tsx` | `apps/editor/CLAUDE.md`（套路 B） | 三处必改：Container / View / viewComponentMap |
| 加跨进程服务 | `apps/editor/src/main/services/` + `apps/editor/src/renderer/main.tsx` | `apps/editor/CLAUDE.md`（套路 C） | `ProxyChannel.fromService` / `toService`，通道名走 `shared/ipc/channelNames.ts` |
| 加 Contribution（生命周期挂钩） | `apps/editor/src/renderer/contributions/` | `apps/editor/CLAUDE.md`（套路 D） | 选 `WorkbenchPhase`，在 `contributions/index.ts` 注册 |
| 加 StatusBar 条目 | `apps/editor/src/renderer/workbench/statusbar/` | `apps/editor/CLAUDE.md`（套路 E） | `addEntry` + accessor `update/dispose` 生命周期 |
| 加 platform 内核 API（DI/Event/Command） | `packages/platform/src/` | `packages/platform/CLAUDE.md` | **必须**在 `packages/platform/src/index.ts` re-export |
| 加共享工具函数 | `packages/shared/src/` | `packages/shared/CLAUDE.md` | 零运行时依赖；从 `index.ts` 导出 |
| 加共享 UI 组件 | `packages/ui/src/` | `packages/ui/CLAUDE.md` | 依赖 `packages/shared`；happy-dom 测试 |
| 加后端路由（demo） | `apps/api/src/` | `apps/api/CLAUDE.md` | Hono `app.get/post` 三行骨架 |
| 加前端 demo 页面 | `apps/web/src/` | `apps/web/CLAUDE.md` | 使用 `packages/ui` 与 `packages/shared` |
| 调整 tsconfig 预设 | `packages/config-ts/` | `packages/config-ts/CLAUDE.md` | strict 三件套不可在子包覆盖关掉 |
| 调整 ESLint 规则 | `packages/config-eslint/` | `packages/config-eslint/CLAUDE.md` | flat config；base + react 两套 |

## 常用命令

```bash
pnpm dev          # 启动所有 dev（shared/ui/platform 先 watch 构建）
pnpm check        # lint + typecheck + test + build（提交前跑这个）
pnpm lint:fix     # 自动修复格式 + lint

pnpm --filter @universe-editor/editor dev   # 只启动桌面编辑器
pnpm --filter @universe-editor/platform test
```

## 跨包共同约定

**包依赖传递**：修改 `shared` / `ui` / `platform` 后，apps 看到的是 `dist/`。`pnpm dev` 下 watcher 会自动重建；离开 dev 模式时手动 `pnpm build` 或 `pnpm --filter <pkg> build`，否则 apps 仍使用旧产物。

**TS 严格性**：开启 `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（定义在 `packages/config-ts/base.json`，子包不要覆盖关掉）。这意味着：
- 数组/对象索引返回 `T | undefined`，必须显式处理
- 可选属性写 `prop?: T`（而不是 `prop: T | undefined`），二者不可互换

**测试**：测试文件位于 `src/**/__tests__/`，命名 `*.test.ts(x)`。环境：
- API / platform / 主进程 → node
- web / ui / renderer → happy-dom + `@testing-library/react`
- `apps/editor` 用 vitest `test.projects` 同时跑 main（node）和 renderer（happy-dom）

**版本管理**：依赖版本统一在 `pnpm-workspace.yaml` 的 `catalog:` 下，包内 `package.json` 写 `"catalog:"` 而非具体版本号。

**ESM only**：所有包 `"type": "module"`；相对导入带 `.js` 后缀（即使源文件是 `.ts`），TS 的 `NodeNext`/`bundler` 模块解析依赖这点。

## 代码风格

Prettier：无分号、单引号、`trailingComma: all`、宽度 100。默认不写注释；只有"为什么这样"非显然时才写一行。文档不重复代码里能读到的内容。

## CI

`.github/workflows/ci.yml` 在 push/PR 到 `main` 时按顺序跑 `lint → typecheck → test → build`。CI 设置了 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，`pnpm-workspace.yaml` 的 `allowBuilds` 显式允许 `electron` / `esbuild` 的 install hook（pnpm 10 默认拒绝）。
