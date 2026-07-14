import { AnchoredSurface } from '@universe-editor/workbench-ui'
import styles from './SwarmReviewContextMenu.module.css'

export type SwarmReviewMenuItem =
  | {
      readonly kind: 'item'
      readonly label: string
      readonly danger?: boolean
      readonly run: () => void
    }
  | { readonly kind: 'separator' }

export interface SwarmReviewContextMenuState {
  readonly x: number
  readonly y: number
  readonly reviewId: string
  readonly items: readonly SwarmReviewMenuItem[]
}

export function SwarmReviewContextMenu({
  state,
  onClose,
}: {
  state: SwarmReviewContextMenuState
  onClose: () => void
}) {
  return (
    <AnchoredSurface x={state.x} y={state.y} onClose={onClose}>
      <ul role="menu" className={styles['menu']}>
        {state.items.map((item, index) =>
          item.kind === 'separator' ? (
            <li key={`separator-${index}`} role="separator" className={styles['separator']} />
          ) : (
            <li
              key={`${item.label}-${index}`}
              role="menuitem"
              tabIndex={-1}
              className={`${styles['item']} ${item.danger ? styles['danger'] : ''}`}
              onClick={() => {
                onClose()
                item.run()
              }}
            >
              {item.label}
            </li>
          ),
        )}
      </ul>
    </AnchoredSurface>
  )
}
