import type { ReactNode } from 'react'

export interface ContextViewAnchor {
  readonly x: number
  readonly y: number
}

export interface IContextViewService {
  show(anchor: ContextViewAnchor, render: () => ReactNode): void
  hide(): void
}
