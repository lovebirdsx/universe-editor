# CLAUDE.md

## 项目简介

TypeScript monorepo，使用 Turborepo 管理任务依赖，pnpm workspace + catalog 统一版本。

## 技术栈

| 层次     | 技术                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| 包管理   | pnpm 10 + workspace catalog                                                      |
| 构建编排 | Turborepo 2                                                                      |
| 语言     | TypeScript 5.8（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes） |
| API      | Hono 4 + @hono/node-server，tsx watch 开发                                       |
| 前端     | React 19 + Vite 7                                                                |
| 测试     | Vitest 3（API: node 环境；Web/UI: happy-dom）                                    |
| Lint     | ESLint 9 flat config + Prettier 3                                                |
| 发版     | Changesets                                                                       |
| CI       | GitHub Actions（ubuntu-latest, Node 22）                                         |

## 目录结构

```
apps/
  api/        # @universe-agent/api — Hono + Node，src/__tests__/
  web/        # @universe-agent/web — Vite + React，src/__tests__/
packages/
  shared/     # @universe-agent/shared — 纯工具函数，编译输出 dist/
  ui/         # @universe-agent/ui — React 组件库，编译输出 dist/
  config-eslint/  # 共享 ESLint flat config（base / react）
  config-ts/      # 共享 tsconfig 预设（base / react / node）
```

## 开发命令

```bash
pnpm install              # 安装依赖（首次或更新后）

# 全局（通过 Turborepo，自动处理依赖顺序）
pnpm dev                  # 启动所有 dev 服务（shared/ui 先 watch 构建）
pnpm build                # 全量构建
pnpm typecheck            # 全量类型检查
pnpm lint                 # 检查（含 Prettier 格式）
pnpm lint:fix             # 自动修复
pnpm test                 # 全量测试
pnpm check                # lint + typecheck + test + build
```

## 任务依赖规则（Turborepo）

- `build` / `typecheck` / `test` / `dev` 均依赖 `^build`（即先构建所有上游包）
- 修改 `shared` 或 `ui` 后，**必须先 build 才能让 apps 感知到变更**
- `dev` 模式下 shared/ui 用 `tsc --build --watch` 持续输出 dist

## 测试规范

- 测试文件放在 `src/__tests__/` 下，命名 `*.test.ts` 或 `*.test.tsx`
- API 包：默认 node 环境（Vitest）
- Web / UI 包：`happy-dom` 环境，使用 `@testing-library/react`
- 根 `vitest.config.ts` 通过 `projects` 聚合所有包
- CI 在 `pnpm test` 前先执行 `pnpm lint` 和 `pnpm typecheck`

## CI 规则

GitHub Actions（`.github/workflows/ci.yml`）在 push/PR 到 `main` 时按顺序执行：
1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`

合并前四步必须全部通过。
