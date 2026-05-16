# packages/shared/CLAUDE.md

纯工具函数库，**零运行时依赖**。被 `apps/api`、`apps/web`、`packages/ui` 共用。

## 产物

`tsup`/`tsc` 构建到 `dist/`。其他包通过 `dist/` 消费——`pnpm dev` 下 watcher 自动重建，否则手动 `pnpm --filter @universe-editor/shared build`。

## 命令

```bash
pnpm --filter @universe-editor/shared dev     # watch 构建
pnpm --filter @universe-editor/shared test    # vitest (node)
pnpm --filter @universe-editor/shared build
```

## 现有工具

- `formatMoney(amount, currency='USD')`：基于 `Intl.NumberFormat`
- `cn(...classes)`：合并 className，过滤 falsy

## 加新工具

在 `src/utils.ts`（或新建文件）：
```ts
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
```
再在 `src/index.ts` 加 `export * from './utils.js'`（已涵盖则跳过）。单测放 `src/__tests__/`。

## 关键约束

- **不引入任何依赖**（包括 React / Node 内置以外的库）
- 函数必须纯，无副作用——本包被服务端、浏览器、Electron 三处共用
