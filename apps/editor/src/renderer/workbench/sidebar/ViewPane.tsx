import { useState, type ComponentType, type DragEvent, type ReactNode } from 'react'
import { MenuId } from '@universe-editor/platform'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ViewTitleActions } from '../viewContainerHeader/ViewTitleActions.js'
import { useViewScopedContextKey } from '../viewContainerHeader/useViewScopedContextKey.js'
import { VIEW_DRAG_MIME, dragContainsView, viewDragData } from '../dnd/viewDragData.js'
import styles from './ViewPane.module.css'

interface ViewPaneProps {
  viewId: string
  title: string
  children: ReactNode
  open: boolean
  onToggle: () => void
  toolbar?: ComponentType | undefined
  draggable?: boolean
  onDropView?: (sourceViewId: string, position: 'before' | 'after') => void
}

export function ViewPane({
  viewId,
  title,
  children,
  open,
  onToggle,
  toolbar,
  draggable = false,
  onDropView,
}: ViewPaneProps) {
  const ctx = useViewScopedContextKey(viewId)
  const Toolbar = toolbar
  const [dragging, setDragging] = useState(false)
  const [dropEdge, setDropEdge] = useState<'before' | 'after' | undefined>(undefined)

  const handleDragStart = (e: DragEvent) => {
    viewDragData.set({ kind: 'view', id: viewId })
    e.dataTransfer.setData(VIEW_DRAG_MIME, viewId)
    e.dataTransfer.effectAllowed = 'move'
    setDragging(true)
  }

  const handleDragEnd = () => {
    viewDragData.clear()
    setDragging(false)
    setDropEdge(undefined)
  }

  const acceptsDrop = (e: DragEvent): boolean => {
    if (!onDropView || !dragContainsView(e.dataTransfer)) return false
    const payload = viewDragData.get()
    return payload?.kind === 'view' && payload.id !== viewId
  }

  const handleDragOver = (e: DragEvent) => {
    if (!acceptsDrop(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    setDropEdge(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
  }

  const handleDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropEdge(undefined)
  }

  const handleDrop = (e: DragEvent) => {
    if (!acceptsDrop(e)) return
    e.preventDefault()
    const payload = viewDragData.get()
    const position = dropEdge ?? 'after'
    setDropEdge(undefined)
    if (payload) onDropView?.(payload.id, position)
  }

  const sectionClass = [
    styles['viewPane'],
    dragging ? styles['dragging'] : '',
    dropEdge === 'before' ? styles['dropTop'] : '',
    dropEdge === 'after' ? styles['dropBottom'] : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section
      className={sectionClass}
      data-view-pane={viewId}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={styles['header']}
        draggable={draggable}
        onDragStart={draggable ? handleDragStart : undefined}
        onDragEnd={draggable ? handleDragEnd : undefined}
      >
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
