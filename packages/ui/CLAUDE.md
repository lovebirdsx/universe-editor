# packages/ui/CLAUDE.md

通用 React 组件库，依赖 `@universe-editor/shared`（用 `cn` 合并 className）。被 `apps/web` 与未来 apps 复用。

## 产物

构建到 `dist/`；`pnpm dev` 下 watcher 自动重建。

## 命令

```bash
pnpm --filter @universe-editor/ui dev      # watch 构建
pnpm --filter @universe-editor/ui test     # vitest (happy-dom)
pnpm --filter @universe-editor/ui build
```

## 现有组件

- `Button`（`variant: 'primary' | 'secondary' | 'ghost'`，`size: 'sm' | 'md' | 'lg'`）：用内联 style + CSS 变量；与 UE5 暗色主题对齐

## 加新组件

```tsx
// src/MyWidget.tsx
import * as React from 'react'
import { cn } from '@universe-editor/shared'

export interface MyWidgetProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: 'info' | 'warn'
}

export function MyWidget({ tone = 'info', className, ...rest }: MyWidgetProps) {
  return <div className={cn('ue-widget', `ue-widget--${tone}`, className)} {...rest} />
}
```
在 `src/index.ts` 加 `export * from './MyWidget.js'`。单测：
```tsx
import { render, screen } from '@testing-library/react'
import { MyWidget } from '../MyWidget.js'
it('renders', () => { render(<MyWidget>hi</MyWidget>); expect(screen.getByText('hi')).toBeTruthy() })
```

## 关键约束

- 测试环境：happy-dom
- 颜色用 CSS 变量 `var(--color-foreground, fallback)`，方便主题切换
- className 命名 `ue-<component>` / `ue-<component>--<variant>`
- 不依赖 `@universe-editor/platform`（保持作为通用组件库）
