import { useState, useCallback, type DragEvent } from 'react'
import {
  ViewContainerLocation,
  IViewsService,
  ILayoutService,
  PartId,
  localize,
} from '@universe-editor/platform'
import type { IPart, IViewContainerDescriptor } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { useViewDescriptors } from '../dnd/useViewDescriptors.js'
import { VIEW_DRAG_MIME, dragContainsView, viewDragData } from '../dnd/viewDragData.js'
import { IActivityService } from '../../services/activity/ActivityService.js'
import { usePartContainer } from '../usePartContainer.js'
import { resolveActivityIcon } from './icon-map.js'
import styles from './ActivityBar.module.css'

interface ActivityBarItemProps {
  descriptor: IViewContainerDescriptor
  isActive: boolean
  onClick: () => void
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  dragging: boolean
  dropEdge: 'before' | 'after' | undefined
}

function ActivityBarItem({
  descriptor,
  isActive,
  onClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  dragging,
  dropEdge,
}: ActivityBarItemProps) {
  const [showTooltip, setShowTooltip] = useState(false)
  const activityService = useService(IActivityService)
  const badge = useObservable(activityService.getBadge(descriptor.id))
  const Icon = resolveActivityIcon(descriptor.icon)

  const className = [
    styles['item'],
    isActive ? styles['active'] : '',
    dragging ? styles['dragging'] : '',
    dropEdge === 'before' ? styles['dropBefore'] : '',
    dropEdge === 'after' ? styles['dropAfter'] : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      className={className}
      onClick={onClick}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      title={descriptor.label}
      aria-label={descriptor.label}
      aria-pressed={isActive}
      data-testid={`activitybar-item-${descriptor.id}`}
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden />
      {badge && badge.count > 0 && (
        <span className={styles['badge']} data-testid={`activitybar-badge-${descriptor.id}`}>
          {badge.count > 99 ? '99+' : badge.count}
        </span>
      )}
      {showTooltip && <span className={styles['tooltip']}>{descriptor.label}</span>}
    </button>
  )
}

export function ActivityBar({ part }: { part?: IPart | undefined } = {}) {
  const viewsService = useService(IViewsService)
  const layoutService = useService(ILayoutService)
  const viewDescriptors = useViewDescriptors()
  const activeContainerByLocation = useObservable(viewsService.activeContainerByLocation)
  const activeId = activeContainerByLocation[ViewContainerLocation.SideBar]
  const containerRef = usePartContainer<HTMLElement>(part)

  const containers = viewDescriptors.getViewContainersByLocation(ViewContainerLocation.SideBar)

  const [draggingId, setDraggingId] = useState<string | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<
    { id: string; edge: 'before' | 'after' } | undefined
  >(undefined)

  const handleClick = useCallback(
    (id: string) => {
      const sidebarVisible = layoutService.getVisible(PartId.SideBar)
      if (activeId === id && sidebarVisible) {
        viewsService.closeViewContainer(id)
        layoutService.setVisible(PartId.SideBar, false)
      } else {
        viewsService.openViewContainer(id)
        if (!sidebarVisible) {
          layoutService.setVisible(PartId.SideBar, true)
        }
      }
    },
    [viewsService, layoutService, activeId],
  )

  const dropPayload = (e: DragEvent): { kind: 'view' | 'container'; id: string } | undefined => {
    if (!dragContainsView(e.dataTransfer)) return undefined
    return viewDragData.get()
  }

  const onItemDragOver = (targetId: string) => (e: DragEvent) => {
    const payload = dropPayload(e)
    if (!payload) return
    if (payload.kind === 'container' && payload.id === targetId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (payload.kind === 'container') {
      const rect = e.currentTarget.getBoundingClientRect()
      const edge = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      setDropTarget({ id: targetId, edge })
    } else {
      setDropTarget({ id: targetId, edge: 'after' })
    }
  }

  const onItemDrop = (targetId: string) => (e: DragEvent) => {
    const payload = dropPayload(e)
    setDropTarget(undefined)
    if (!payload) return
    e.preventDefault()
    if (payload.kind === 'container') {
      if (payload.id !== targetId) viewDescriptors.moveContainerInLocation(payload.id, targetId)
    } else {
      viewDescriptors.moveViewsToContainer([payload.id], targetId)
    }
  }

  return (
    <nav
      ref={containerRef}
      className={styles['activitybar']}
      aria-label={localize('menu.activityBar', 'Activity Bar')}
      data-testid="part-activitybar"
    >
      <div className={styles['items']}>
        {containers.map((c) => (
          <ActivityBarItem
            key={c.id}
            descriptor={c}
            isActive={activeId === c.id}
            onClick={() => handleClick(c.id)}
            dragging={draggingId === c.id}
            dropEdge={dropTarget?.id === c.id ? dropTarget.edge : undefined}
            onDragStart={(e) => {
              viewDragData.set({ kind: 'container', id: c.id })
              e.dataTransfer.setData(VIEW_DRAG_MIME, c.id)
              e.dataTransfer.effectAllowed = 'move'
              setDraggingId(c.id)
            }}
            onDragEnd={() => {
              viewDragData.clear()
              setDraggingId(undefined)
              setDropTarget(undefined)
            }}
            onDragOver={onItemDragOver(c.id)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                setDropTarget(undefined)
            }}
            onDrop={onItemDrop(c.id)}
          />
        ))}
      </div>
    </nav>
  )
}
