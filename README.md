# Universe Editor

VSCode 范式的桌面游戏内容编辑器（TypeScript monorepo）。

## 快速上手

```bash
pnpm install              # 首次或依赖更新后
pnpm dev                  # 启动所有 dev（推荐）

# 或单独启动
pnpm --filter @universe-editor/editor dev     # 桌面编辑器（Electron）
pnpm --filter @universe-editor/api dev        # http://localhost:3001
pnpm --filter @universe-editor/web dev        # http://localhost:3000
```

## 仓库结构

```
apps/
  api/      Hono + Node
  web/      Vite + React
  editor/   Electron 桌面编辑器（main / preload / renderer）
packages/
  shared/         纯工具函数
  ui/             React 组件库
  platform/       VSCode 风格内核（DI / Command / IPC / Workbench services）
  config-ts/      共享 tsconfig 预设
  config-eslint/  共享 ESLint flat config
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | 快速校验：lint + typecheck + test |
| `pnpm check:full` | 全量验收：lint + typecheck + test + build（提交前跑这个） |
| `pnpm build` | 全量构建 |
| `pnpm test` | 全量测试 |
| `pnpm typecheck` | 全量类型检查 |
| `pnpm lint` / `lint:fix` | 代码规范 + Prettier 格式 |
| `pnpm --filter @universe-editor/editor package:win` | 构建 Windows 安装器 + `win-unpacked` 可执行目录 |
| `pnpm --filter @universe-editor/editor package:win:installer` | 仅构建 Windows NSIS 安装器 |
| `pnpm --filter @universe-editor/editor package:win:dir` | 仅构建 Windows `win-unpacked` 目录包 |
| `pnpm changeset` | 声明变更（配合 `version-packages` / `publish-packages` 发版） |

技术栈：pnpm 10 · Turborepo 2 · TypeScript 5.8 · React 19 · Hono 4 · Electron 33 · Vitest 3。

## Windows 打包

```bash
pnpm --filter @universe-editor/editor package:win
```

构建产物输出到 `apps/editor/release/`：

- `win-unpacked/Universe Editor.exe`：免安装目录包，适合本地冒烟验证
- `Universe Editor-<version>-win-x64.exe`：NSIS 安装器，适合分发给最终用户

当前 Windows 产物默认未签名，首次运行可能触发 SmartScreen 警告；仓库里也还没有自定义应用图标，会继续使用 Electron 默认图标。

开发约定与陷阱详见 [CLAUDE.md](./CLAUDE.md)。
