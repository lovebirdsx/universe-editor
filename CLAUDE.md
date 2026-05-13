# CLAUDE.md

## 项目简介

TypeScript monorepo，使用 Turborepo 管理任务依赖，pnpm workspace + catalog 统一版本。终极目标是构建一个 VSCode 范式的桌面游戏内容编辑器（详见 [vscode-vscode-command-ipc-service-vscod-giggly-canyon.md](./vscode-vscode-command-ipc-service-vscod-giggly-canyon.md)）。

## 技术栈

| 层次     | 技术                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| 包管理   | pnpm 10 + workspace catalog                                                      |
| 构建编排 | Turborepo 2                                                                      |
| 语言     | TypeScript 5.8（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes） |
| API      | Hono 4 + @hono/node-server，tsx watch 开发                                       |
| 前端     | React 19 + Vite 7                                                                |
| 桌面     | Electron 33 + electron-vite（main/preload/renderer 三端一体）+ electron-builder  |
| 测试     | Vitest 3（node 环境：API/main 进程；happy-dom：Web/UI/renderer）                 |
| Lint     | ESLint 9 flat config + Prettier 3                                                |
| 发版     | Changesets                                                                       |
| CI       | GitHub Actions（ubuntu-latest, Node 22，淘宝 Electron 镜像）                     |

## 目录结构

```
apps/
  api/        # @universe-editor/api — Hono + Node，src/__tests__/
  web/        # @universe-editor/web — Vite + React，src/__tests__/
  editor/     # @universe-editor/editor — Electron 桌面外壳；src/{main,preload,renderer,shared}
packages/
  shared/         # @universe-editor/shared — 纯工具函数，编译输出 dist/
  ui/             # @universe-editor/ui — React 组件库，编译输出 dist/
  platform/       # @universe-editor/platform — VSCode 风格内核（M1 起填充：DI/Lifecycle/Command/...）
  config-eslint/  # 共享 ESLint flat config（base / react）
  config-ts/      # 共享 tsconfig 预设（base / react / node）
```

## 开发命令

```bash
pnpm install              # 安装依赖（首次或更新后）

# 全局（通过 Turborepo，自动处理依赖顺序）
pnpm dev                  # 启动所有 dev 服务（shared/ui/platform 先 watch 构建）
pnpm build                # 全量构建
pnpm typecheck            # 全量类型检查
pnpm lint                 # 检查（含 Prettier 格式）
pnpm lint:fix             # 自动修复
pnpm test                 # 全量测试
pnpm check                # lint + typecheck + test + build

# 单独启动桌面编辑器
pnpm --filter @universe-editor/editor dev
```

## 任务依赖规则（Turborepo）

- `build` / `typecheck` / `test` / `dev` 均依赖 `^build`（即先构建所有上游包）
- 修改 `shared` / `ui` / `platform` 后，**必须先 build 才能让 apps 感知到变更**
- `dev` 模式下 shared/ui/platform 用 `tsc --build --watch` 持续输出 dist
- `editor` 包 `dev` 是 persistent task（electron-vite 三端 HMR）

## 测试规范

- 测试文件放在 `src/__tests__/` 下，命名 `*.test.ts` 或 `*.test.tsx`
- API 包：默认 node 环境（Vitest）
- Web / UI 包：`happy-dom` 环境，使用 `@testing-library/react`
- Editor 包：vitest 3 的 `test.projects` 双项目 —— main 侧 node 环境、renderer 侧 happy-dom
- CI 在 `pnpm test` 前先执行 `pnpm lint` 和 `pnpm typecheck`

## Editor 包架构约定（M0 雏形 → M1+ 演进）

- `src/main/`：Electron 主进程；业务函数（如 `handlePing`）从 `ipc.ts` 抽出到独立文件，便于不依赖 Electron 单测
- `src/preload/`：仅通过 `contextBridge.exposeInMainWorld` 暴露白名单 API，channel 名走 `src/shared/ipc-channels.ts` 的常量
- `src/renderer/`：React 19 + Vite 7；通过 `window.api` 调用主进程，类型由 `global.d.ts` 声明
- `src/shared/`：main / preload / renderer 共享的 IPC 通道名、消息类型
- 构建产物在 `out/{main,preload,renderer}`（electron-vite 约定，不要改）

## CI 规则

GitHub Actions（`.github/workflows/ci.yml`）在 push/PR 到 `main` 时按顺序执行：
1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`

合并前四步必须全部通过。CI 设置了 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 加速 Electron 二进制下载；`pnpm-workspace.yaml` 的 `allowBuilds` 显式允许 `electron` 的 install hook（pnpm 10 默认拒绝）。CI 不调用 `electron-builder` 出安装包。
