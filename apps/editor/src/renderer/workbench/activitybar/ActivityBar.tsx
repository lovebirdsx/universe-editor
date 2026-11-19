import { useEffect, useLayoutEffect, useState, useCallback, type DragEvent } from 'react'
import {
  ViewContainerLocation,
  IViewsService,
  ILayoutService,
  PartId,
  localize,
} from '@universe-editor/platform'
import type { IPart, IViewContainerDescriptor } from '@universe-editor/platform'
import { useVimSurface } from '@universe-editor/workbench-ui'
import { useService, useObservable } from '../useService.js'
import { useViewDescriptors } from '../dnd/useViewDescriptors.js'
import { VIEW_DRAG_MIME, dragContainsView, viewDragData } from '../dnd/viewDragData.js'
import { applyViewDrop } from '../dnd/applyViewDrop.js'
import { IActivityService } from '../../services/activity/ActivityService.js'
import { viewContainerToggleCommand } from '../../services/views/viewContainerToggleCommand.js'
import { usePartContainer } from '../usePartContainer.js'
import { resolveActivityIcon } from './icon-map.js'
import { resolveContainerIconName } from '../icons/resolveContainerIcon.js'
import styles from './ActivityBar.module.css'

interface ActivityBarItemProps {
  descriptor: IViewContainerDescriptor
  index: number
  isActive: boolean
  tabIndex: number
  onClick: () => void
  onFocus: () => void
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  dragging: boolean
  dropEdge: 'before' | 'after' | 'merge' | undefined
}

function ActivityBarItem({
  descriptor,
  index,
  isActive,
  tabIndex,
  onClick,
  onFocus,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  dragging,
  dropEdge,
}: ActivityBarItemProps) {
  const activityService = useService(IActivityService)
  const viewDescriptors = useViewDescriptors()
  const badge = useObservable(activityService.getBadge(descriptor.id))
  const Icon = resolveActivityIcon(resolveContainerIconName(descriptor, viewDescriptors))

  const className = [
    styles['item'],
    isActive ? styles['active'] : '',
    dragging ? styles['dragging'] : '',
    dropEdge === 'before' ? styles['dropBefore'] : '',
    dropEdge === 'after' ? styles['dropAfter'] : '',
    dropEdge === 'merge' ? styles['dropMerge'] : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      className={className}
      onClick={onClick}
      onFocus={onFocus}
      tabIndex={tabIndex}
      data-activitybar-index={index}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-tooltip={descriptor.label}
      data-tooltip-command={viewContainerToggleCommand(descriptor.id)}
      aria-label={descriptor.label}
      aria-pressed={isActive}
      data-testid={`activitybar-item-${descriptor.id}`}
    >
      <Icon size={22} strokeWidth={1.75} aria-hidden />
      {badge && badge.count > 0 && (
        <span className={styles['badge']} data-testid={`activitybar-badge-${descriptor.id}`}>
          {badge.count > 99 ? '99+' : badge.count}
        </span>
      )}
    </button>
  )
}

interface PartFocusTargetHost {
  _setFocusTarget?(el: HTMLElement | null): void
}

function setPartFocusTarget(part: IPart, el: HTMLElement | null): void {
  const internal = part as unknown as PartFocusTargetHost
  internal._setFocusTarget?.(el)
}

export function ActivityBar({ part }: { part?: IPart | undefined } = {}) {
  const viewsService = useService(IViewsService)
  const layoutService = useService(ILayoutService)
  const viewDescriptors = useViewDescriptors()
  const activeContainerByLocation = useObservable(viewsService.activeContainerByLocation)
  const activeId = activeContainerByLocation[ViewContainerLocation.SideBar]
  const navRef = usePartContainer<HTMLElement>(part)

  const containers = viewDescriptors.getViewContainersByLocation(ViewContainerLocation.SideBar)
  const activeIndex = Math.max(
    0,
    containers.findIndex((container) => container.id === activeId),
  )
  // Roving tabindex cursor. It follows j/k without opening the container; the
  // active-container highlight still follows `activeId`.
  const [focusedIndex, setFocusedIndex] = useState(activeIndex)
  const rovingIndex =
    containers.length === 0 ? -1 : Math.max(0, Math.min(focusedIndex, containers.length - 1))

  // Activation from another surface (command, palette, click on a tab header)
  // moves the roving cursor to the shown container while focus is outside.
  useEffect(() => {
    const nav = navRef.current
    if (nav !== null && nav.contains(nav.ownerDocument.activeElement)) return
    setFocusedIndex(activeIndex)
  }, [activeIndex, containers.length, navRef])

  // `workbench.action.focusActivityBar` focuses the registered Part; point it
  // at the current item instead of the non-focusable nav so DOM focus visibly
  // lands on the ActivityBar item.
  useLayoutEffect(() => {
    if (part === undefined) return
    const nav = navRef.current
    const index =
      nav !== null && nav.contains(nav.ownerDocument.activeElement) ? rovingIndex : activeIndex
    const target =
      index >= 0
        ? (nav?.querySelector<HTMLElement>(`[data-activitybar-index="${index}"]`) ?? nav)
        : nav
    setPartFocusTarget(part, target ?? null)
    return () => setPartFocusTarget(part, null)
  }, [part, navRef, activeIndex, rovingIndex])

  const activateContainer = useCallback(
    (id: string) => {
      // Mirror FindInFilesAction / container cycling: activating a container
      // also focuses its primary view (focusView opens the container, makes
      // the part visible, and focuses the view's registered focusable).
      const firstViewId = viewDescriptors.getViewsByContainer(id)[0]?.id
      if (firstViewId) {
        void layoutService.focusView(firstViewId, { source: 'user' })
        return
      }
      viewsService.openViewContainer(id)
      if (!layoutService.getVisible(PartId.SideBar)) {
        layoutService.setVisible(PartId.SideBar, true)
      }
    },
    [viewsService, layoutService, viewDescriptors],
  )

  const handleClick = useCallback(
    (id: string) => {
      const sidebarVisible = layoutService.getVisible(PartId.SideBar)
      if (activeId === id && sidebarVisible) {
        viewsService.closeViewContainer(id)
        layoutService.setVisible(PartId.SideBar, false)
      } else {
        activateContainer(id)
      }
    },
    [viewsService, layoutService, activeId, activateContainer],
  )

  const focusItem = useCallback(
    (index: number) => {
      if (containers.length === 0) return
      const clamped = Math.max(0, Math.min(containers.length - 1, index))
      const el = navRef.current?.querySelector<HTMLElement>(`[data-activitybar-index="${clamped}"]`)
      if (el === null || el === undefined) return
      el.focus()
      setFocusedIndex(clamped)
    },
    [containers.length, navRef],
  )

  // Vim `activityBar` surface: j/k move the roving cursor between containers,
  // Enter opens the focused container and hands focus to its first view.
  useVimSurface({
    id: 'activityBar',
    kind: 'activityBar',
    focus: 'within',
    getElement: () => navRef.current,
    getSurfaceKey: () => 'activityBar',
    defaultMode: 'normal',
    actions: {
      move: (direction, count) => {
        const delta = direction === 'up' || direction === 'left' ? -1 : 1
        focusItem(rovingIndex + delta * Math.max(1, count))
      },
      next: (count) => focusItem(rovingIndex + Math.max(1, count)),
      previous: (count) => focusItem(rovingIndex - Math.max(1, count)),
      first: (count) => focusItem(count > 1 ? count - 1 : 0),
      last: (count) => focusItem(count > 1 ? count - 1 : containers.length - 1),
      activate: () => {
        const target = containers[rovingIndex]
        if (target !== undefined) activateContainer(target.id)
      },
    },
  })

  const [draggingId, setDraggingId] = useState<string | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<
    { id: string; edge: 'before' | 'after' | 'merge' } | undefined
  >(undefined)
  const [locationDropActive, setLocationDropActive] = useState(false)

  const dropPayload = (e: DragEvent): { kind: 'view' | 'container'; id: string } | undefined => {
    if (!dragContainsView(e.dataTransfer)) return undefined
    return viewDragData.get()
  }

  const containerEdge = (e: DragEvent): 'before' | 'after' | 'merge' => {
    const rect = e.currentTarget.getBoundingClientRect()
    const offset = (e.clientY - rect.top) / rect.height
    return offset < 0.25 ? 'before' : offset > 0.75 ? 'after' : 'merge'
  }

  const onItemDragOver = (targetId: string) => (e: DragEvent) => {
    const payload = dropPayload(e)
    if (!payload) return
    if (payload.kind === 'container' && payload.id === targetId) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setLocationDropActive(false)
    setDropTarget({ id: targetId, edge: payload.kind === 'container' ? containerEdge(e) : 'merge' })
  }

  const onItemDrop = (targetId: string) => (e: DragEvent) => {
    const payload = dropPayload(e)
    if (!payload) {
      setDropTarget(undefined)
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const merge = payload.kind === 'container' ? containerEdge(e) === 'merge' : false
    setDropTarget(undefined)
    applyViewDrop(viewDescriptors, payload, { kind: 'container', containerId: targetId, merge })
  }

  const onLocationDragOver = (e: DragEvent) => {
    const payload = dropPayload(e)
    if (!payload) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setLocationDropActive(true)
  }

  const onLocationDrop = (e: DragEvent) => {
    const payload = dropPayload(e)
    setLocationDropActive(false)
    if (!payload) return
    e.preventDefault()
    applyViewDrop(viewDescriptors, payload, {
      kind: 'location',
      location: ViewContainerLocation.SideBar,
    })
  }

  return (
    <nav
      ref={navRef}
      className={`${styles['activitybar']} ${locationDropActive ? styles['locationDrop'] : ''}`}
      aria-label={localize('menu.activityBar', 'Activity Bar')}
      data-testid="part-activitybar"
      tabIndex={-1}
      onDragOver={onLocationDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLocationDropActive(false)
      }}
      onDrop={onLocationDrop}
    >
      <div className={styles['items']}>
        {containers.map((c, index) => (
          <ActivityBarItem
            key={c.id}
            descriptor={c}
            index={index}
            isActive={activeId === c.id}
            tabIndex={index === rovingIndex ? 0 : -1}
            onClick={() => handleClick(c.id)}
            onFocus={() => setFocusedIndex(index)}
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
