import { type ComponentType, type ReactNode } from 'react'
import { MenuId } from '@universe-editor/platform'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ViewTitleActions } from '../viewContainerHeader/ViewTitleActions.js'
import { useViewScopedContextKey } from '../viewContainerHeader/useViewScopedContextKey.js'
import styles from './ViewPane.module.css'

interface ViewPaneProps {
  viewId: string
  title: string
  children: ReactNode
  open: boolean
  onToggle: () => void
  toolbar?: ComponentType | undefined
}

export function ViewPane({ viewId, title, children, open, onToggle, toolbar }: ViewPaneProps) {
  const ctx = useViewScopedContextKey(viewId)
  const Toolbar = toolbar
  return (
    <section className={styles['viewPane']}>
      <div className={styles['header']}>
        <button className={styles['headerToggle']} onClick={onToggle} aria-expanded={open}>
          {open ? (
            <ChevronDown
              size={16}
              strokeWidth={1.75}
              className={styles['chevron']}
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              size={16}
              strokeWidth={1.75}
              className={styles['chevron']}
              aria-hidden="true"
            />
          )}
          {title}
        </button>
        <div className={styles['headerActions']}>
          {Toolbar ? <Toolbar /> : null}
          <ViewTitleActions menuId={MenuId.ViewTitle} contextKeyService={ctx} />
        </div>
      </div>
      <div className={`${styles['body']} ${open ? '' : styles['collapsed']}`}>{children}</div>
    </section>
  )
}
