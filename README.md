# Universe Editor

VSCode 范式的桌面游戏内容编辑器（TypeScript monorepo）。

## 快速上手

```bash
git submodule update --init   # 首次克隆后（或 clone --recurse-submodules）
pnpm install
pnpm dev                      # 启动编辑器（开发模式）
```

AI agent 功能依赖 `vendor/` 下的 ACP fork，首次使用或更新 fork 后需执行 `pnpm agent:build`。

### 环境要求（Windows）

- Node 22 + pnpm 11（corepack）
- **MSVC C++ 工具链**：Visual Studio 2022 或 Build Tools 的「使用 C++ 的桌面开发」工作负载 + 任一 Windows 10/11 SDK

## 仓库结构

```
apps/
  editor/             Electron 桌面编辑器（main / preload / renderer）
packages/
  platform/           VSCode 风格内核（DI / Event / Command / Workbench services）
  workbench-ui/       通用 UI 控件库
  extension-host/     扩展运行时（配套 extension-api / extension-manifest / extension-packaging）
  config-ts/          共享 tsconfig 预设
  config-eslint/      共享 ESLint flat config
extensions/           内置扩展（typescript / git / markdown / ai / perforce / 主题等）
extensions-external/  外部扩展范例（pdf / eslint / excel-diff 等）
vendor/               内置 ACP agent fork（claude-agent-acp / codex-acp）等，独立工具链构建
docs/                 用户文档（user/）与开发文档（development/）
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动编辑器（开发模式，热更新） |
| `pnpm check` | 快速校验：lint + typecheck + 按变更选测试 |
| `pnpm check:full` | 全量校验：lint + typecheck + test + build |
| `pnpm test` | 全量测试 |
| `pnpm e2e:smoke` | @p0 核心端到端冒烟 |
| `pnpm e2e` | 全量端到端测试 |
| `pnpm build` | 全量构建 |

## Windows 打包

```bash
pnpm --filter @universe-editor/editor package:win
```

产物输出到 `apps/editor/release/`：`win-unpacked/` 免安装目录包 + NSIS 安装器。产物默认未签名，首次运行可能触发 SmartScreen 警告。

## 共享 Claude memory

本仓库把 Claude memory 真身放在 `.claude/memory/` 并纳入 git，通过链接实现跨 clone / 跨机共享：

```bash
pnpm memory:link      # 每个 clone / 每台新机器各跑一次
pnpm memory:status    # 只查看链接状态
```

## 更多

开发约定、各子目录导航与常见套路详见 [CLAUDE.md](./CLAUDE.md)。

技术栈：pnpm 11 · Turborepo 2 · TypeScript 5.8 · React 19 · Electron 43 (electron-vite) · Monaco · Vitest 3 · Playwright
