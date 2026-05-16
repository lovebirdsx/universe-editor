# apps/web/CLAUDE.md

Vite + React 19 的独立前端 demo。**与 `apps/editor` 无耦合**，纯粹是验证 `packages/ui` + `packages/shared` 可被普通浏览器 SPA 消费的样例。

## 命令

```bash
pnpm --filter @universe-editor/web dev       # Vite dev server
pnpm --filter @universe-editor/web test      # vitest (happy-dom)
pnpm --filter @universe-editor/web build
```

## 依赖

- `@universe-editor/ui` 的 `Button`
- `@universe-editor/shared` 的 `formatMoney` / `cn`

不要 import `@universe-editor/platform`（platform 是 workbench-only 内核）。

## 加页面

在 `src/App.tsx` 直接加组件；或新建 `src/pages/MyPage.tsx` 引入。测试用 `@testing-library/react`：
```tsx
import { render, screen } from '@testing-library/react'
import { App } from '../App.js'

it('renders', () => {
  render(<App />)
  expect(screen.getByText(/Acme/)).toBeTruthy()
})
```

## 关键约束

- 测试环境：happy-dom
- 入口：`src/main.tsx` → `createRoot(...).render(<App />)`
- 改了 `packages/ui` / `packages/shared` 后，本 app 看到的是 `dist/`——`pnpm dev` 下 watcher 自动重建
