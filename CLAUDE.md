# CLAUDE.md

VSCode 范式的桌面游戏内容编辑器。本仓库通过分层 CLAUDE.md 指导：根文件做**导航 + 跨包共同约定**；进入子目录后请优先阅读该目录的 CLAUDE.md。

## 仓库布局

pnpm workspace + Turborepo 的 monorepo，全部 ESM (`"type": "module"`)。

```
apps/
  editor/   Electron 33 + electron-vite              → apps/editor/CLAUDE.md
packages/
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
| 加性能打点 / 启动耗时检测 | `apps/editor/src/shared/perf/marks.ts` + 打点处 | `apps/editor/CLAUDE.md`（套路 G） | `mark()` 打点 + `PerfMarks` 常量 + `ITimerService` 聚合 |
| 加 E2E 冒烟场景 | `apps/editor/e2e/specs/` | `apps/editor/CLAUDE.md`（套路 F） | Playwright + `_electron`，通过 `window.__E2E__` 探针调服务；`@p0` 阻塞 CI |
| 加 AI 供应商（provider） | `apps/editor/src/main/services/ai/providers/` | `apps/editor/CLAUDE.md`（套路 I） | 实现 `IAiModelProvider` + 一行 `registerProvider`；密钥只走 `ISecretStorageService`，绝不进 renderer/settings.json |
| 加 platform 内核 API（DI/Event/Command） | `packages/platform/src/` | `packages/platform/CLAUDE.md` | **必须**在 `packages/platform/src/index.ts` re-export |
| 调整 tsconfig 预设 | `packages/config-ts/` | `packages/config-ts/CLAUDE.md` | strict 三件套不可在子包覆盖关掉 |
| 调整 ESLint 规则 | `packages/config-eslint/` | `packages/config-eslint/CLAUDE.md` | flat config；base + react 两套 |

## 常用命令

```bash
pnpm check        # 快速校验：lint + typecheck + test
pnpm e2e          # 端到端测试
```

## 跨包共同约定

**包依赖传递**：修改 `platform` 后，apps 看到的是 `dist/`。`pnpm dev` 下 watcher 会自动重建；离开 dev 模式时手动 `pnpm build` 或 `pnpm --filter <pkg> build`，否则 apps 仍使用旧产物。

**TS 严格性**：开启 `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（定义在 `packages/config-ts/base.json`，子包不要覆盖关掉）。这意味着：
- 数组/对象索引返回 `T | undefined`，必须显式处理
- 可选属性写 `prop?: T`（而不是 `prop: T | undefined`），二者不可互换

**测试**：测试文件位于 `src/**/__tests__/`，命名 `*.test.ts(x)`。环境：
- platform / 主进程 → node
- renderer → happy-dom + `@testing-library/react`
- `apps/editor` 用 vitest `test.projects` 同时跑 main（node）和 renderer（happy-dom）

**版本管理**：依赖版本统一在 `pnpm-workspace.yaml` 的 `catalog:` 下，包内 `package.json` 写 `"catalog:"` 而非具体版本号。

**ESM only**：所有包 `"type": "module"`；相对导入带 `.js` 后缀（即使源文件是 `.ts`），TS 的 `NodeNext`/`bundler` 模块解析依赖这点。

**内置 ACP agent（claude-agent-acp fork）**：`vendor/claude-agent-acp` 是 git submodule（我们自维护的 fork），**不在 pnpm workspace 内**，用它自带的 npm 工具链独立构建。
- 克隆仓库后先 `git submodule update --init`（或 `git clone --recurse-submodules`）。
- 改动 fork 或拉取上游后，跑 `pnpm agent:build`（npm ci + tsc + prune 生产依赖）生成 `vendor/claude-agent-acp/{dist,node_modules}`。
- dev 与发布**同一套启动机制**：main 用 Electron 自带 node（`ELECTRON_RUN_AS_NODE`）跑该 fork 的 `dist/index.js`，**不依赖系统 node/npx**。打包时 `electron-builder.yml` 的 `extraResources` 把产物带进 `resources/`（`package:win*` 已串入 `agent:build`）。

## 代码风格

Prettier：无分号、单引号、`trailingComma: all`、宽度 100。默认不写注释；只有"为什么这样"非显然时才写一行。文档不重复代码里能读到的内容。

## 其它

- 完成功能后，用`pnpm check`来验证，如何设计到编辑器交互逻辑的改动，用 `pnpm e2e` 跑冒烟测试验证，这两个命令的输出内容较多，执行时请仅截取错误内容
- 完成新功能后，仅在非常必要的场景，才更新 CLAUDE.md
- 由于该项目还处在开发阶段，功能迭代不用考虑向后兼容
- 仅在有必要的场景，才在代码里写注释；优先考虑通过命名和结构让代码自解释
- 对于关键的逻辑，需要加入对应的调试输出，方便后续分析
- 尽量避免编写重复代码，优先考虑复用，必要时可重构
