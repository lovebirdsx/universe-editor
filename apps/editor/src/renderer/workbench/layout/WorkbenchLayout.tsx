import { useRef, useCallback, type ReactNode } from 'react'
import styles from './WorkbenchLayout.module.css'

interface WorkbenchLayoutProps {
  activitybar: ReactNode
  sidebar: ReactNode
  editor: ReactNode
  panel: ReactNode
  statusbar: ReactNode
  sidebarVisible: boolean
  panelVisible: boolean
}

export function WorkbenchLayout({
  activitybar,
  sidebar,
  editor,
  panel,
  statusbar,
  sidebarVisible,
  panelVisible,
}: WorkbenchLayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  const classNames = [
    styles['workbench'],
    !sidebarVisible ? styles['sidebar-hidden'] : '',
    !panelVisible ? styles['panel-hidden'] : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={rootRef} className={classNames}>
      <div className={styles['activitybar']}>{activitybar}</div>
      <div className={styles['sidebar']}>
        {sidebarVisible && sidebar}
        <SidebarSash containerRef={rootRef} />
      </div>
      <div className={styles['editor']}>{editor}</div>
      <div className={styles['panel']}>
        {panelVisible && panel}
        <PanelSash containerRef={rootRef} />
      </div>
      <div className={styles['statusbar']}>{statusbar}</div>
    </div>
  )
}

// -------- Sash components --------

interface SashProps {
  containerRef: React.RefObject<HTMLDivElement | null>
}

function SidebarSash({ containerRef }: SashProps) {
  const dragging = useRef(false)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      const startX = e.clientX
      const root = containerRef.current
      if (!root) return

      const startWidth = parseInt(
        getComputedStyle(root).getPropertyValue('--sidebar-width') || '240',
        10,
      )

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX
        const next = Math.max(120, Math.min(600, startWidth + delta))
        root.style.setProperty('--sidebar-width', `${next}px`)
      }
      const onUp = () => {
        dragging.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [containerRef],
  )

  return (
    <div
      className={`${styles['sash']} ${styles['sash-vertical']}`}
      style={{ right: 0 }}
      onMouseDown={onMouseDown}
    />
  )
}

function PanelSash({ containerRef }: SashProps) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const root = containerRef.current
      if (!root) return

      const startHeight = parseInt(
        getComputedStyle(root).getPropertyValue('--panel-height') || '200',
        10,
      )

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY
        const next = Math.max(60, Math.min(600, startHeight + delta))
        root.style.setProperty('--panel-height', `${next}px`)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [containerRef],
  )

  return (
    <div
      className={`${styles['sash']} ${styles['sash-horizontal']}`}
      style={{ top: 0 }}
      onMouseDown={onMouseDown}
    />
  )
}
