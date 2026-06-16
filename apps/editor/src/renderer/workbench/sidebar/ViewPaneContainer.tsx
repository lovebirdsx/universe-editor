import { useLayoutEffect, useRef, useState, type ComponentType, type DragEvent } from 'react'
import { Allotment, type AllotmentHandle } from 'allotment'
import 'allotment/dist/style.css'
import type { IViewDescriptor } from '@universe-editor/platform'
import { ViewPane } from './ViewPane.js'
import { useViewDescriptors } from '../dnd/useViewDescriptors.js'
import { dragContainsView, viewDragData } from '../dnd/viewDragData.js'
import '../layout/allotment-theme.css'
import styles from '../paneComposite/PaneComposite.module.css'

const HEADER_H = 28
const MIN_BODY = 60
const OPEN_MIN = HEADER_H + MIN_BODY

interface Props {
  containerId: string
  views: readonly IViewDescriptor[]
  resolve: (componentKey: string) => ComponentType | undefined
  toolbarMap?: ReadonlyMap<string, ComponentType>
  emptyMessage?: string
}

/**
 * Stacks a container's views as collapsible, resizable panes (VSCode PaneView):
 * collapsed panes shrink to their 28-px header and yield space to the open ones;
 * adjacent open panes are resizable via the sashes between them. Collapse and
 * size are persisted through IViewDescriptorService; views can be dragged within
 * and across containers.
 */
export function ViewPaneContainer({
  containerId,
  views,
  resolve,
  toolbarMap,
  emptyMessage = 'No views registered.',
}: Props) {
  const viewDescriptors = useViewDescriptors()
  const allotmentRef = useRef<AllotmentHandle>(null)
  const sizesRef = useRef<number[]>([])
  const [overEmpty, setOverEmpty] = useState(false)

  const collapsed = (id: string) => viewDescriptors.getViewState(id).collapsed === true
  const toggle = (id: string) => viewDescriptors.setViewCollapsed(id, !collapsed(id))

  const moveHere = (sourceViewId: string, targetViewId: string, position: 'before' | 'after') => {
    const sourceContainer = viewDescriptors.getViewContainerByViewId(sourceViewId)?.id
    if (sourceContainer !== containerId) {
      viewDescriptors.moveViewsToContainer([sourceViewId], containerId)
    }
    const ordered = viewDescriptors.getViewsByContainer(containerId).map((v) => v.id)
    let anchor = targetViewId
    if (position === 'after') {
      const idx = ordered.indexOf(targetViewId)
      const next = ordered[idx + 1]
      if (next && next !== sourceViewId) anchor = next
      else if (idx === ordered.length - 1) {
        // Dropping after the last view: move to the very end.
        const last = ordered[ordered.length - 1]
        if (last && last !== sourceViewId) {
          viewDescriptors.moveViewInContainer(containerId, sourceViewId, last)
        }
        return
      }
    }
    viewDescriptors.moveViewInContainer(containerId, sourceViewId, anchor)
  }

  // After a collapse/expand toggle, hand collapsed panes their header height and
  // split the rest equally among the open panes — Allotment alone would leave the
  // freed space on the just-collapsed pane. The length guard skips runs where
  // Allotment hasn't yet committed its view items for the current `views`.
  const collapsedKey = views.map((v) => (collapsed(v.id) ? '1' : '0')).join('')
  useLayoutEffect(() => {
    const handle = allotmentRef.current
    if (!handle) return
    const sizes = sizesRef.current
    if (sizes.length !== views.length) return
    const total = sizes.reduce((sum, n) => sum + n, 0)
    if (total <= 0) return
    const openCount = views.reduce((n, v) => (collapsed(v.id) ? n : n + 1), 0)
    if (openCount === 0) return
    const each = (total - HEADER_H * (views.length - openCount)) / openCount
    handle.resize(views.map((v) => (collapsed(v.id) ? HEADER_H : each)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsedKey])

  const acceptsContainerDrop = (e: DragEvent): boolean => {
    if (!dragContainsView(e.dataTransfer)) return false
    const payload = viewDragData.get()
    if (payload?.kind !== 'view') return false
    return viewDescriptors.getViewContainerByViewId(payload.id)?.id !== containerId
  }

  const onEmptyDragOver = (e: DragEvent) => {
    if (!acceptsContainerDrop(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverEmpty(true)
  }

  const onEmptyDrop = (e: DragEvent) => {
    if (!acceptsContainerDrop(e)) return
    e.preventDefault()
    setOverEmpty(false)
    const payload = viewDragData.get()
    if (payload) viewDescriptors.moveViewsToContainer([payload.id], containerId)
  }

  if (views.length === 0) {
    return (
      <div
        className={`${styles['emptyDrop']} ${overEmpty ? styles['emptyDropOver'] : ''}`}
        onDragOver={onEmptyDragOver}
        onDragLeave={() => setOverEmpty(false)}
        onDrop={onEmptyDrop}
        data-empty-drop={containerId}
      >
        <p className={styles['empty']}>{emptyMessage}</p>
      </div>
    )
  }

  if (views.length === 1) {
    const v = views[0]!
    const Component = resolve(v.componentKey)
    return (
      <div
        data-view-id={v.id}
        className={styles['viewBody']}
        style={{ flex: 1, minHeight: 0 }}
        onDragOver={onEmptyDragOver}
        onDrop={onEmptyDrop}
      >
        {Component ? <Component /> : <span className={styles['empty']}>{v.name}</span>}
      </div>
    )
  }

  return (
    <Allotment
      ref={allotmentRef}
      vertical
      onChange={(s) => {
        sizesRef.current = s
        viewDescriptors.setViewSizes(views.map((v, i) => ({ id: v.id, size: s[i] ?? 0 })))
      }}
    >
      {views.map((v) => {
        const isCollapsed = collapsed(v.id)
        const Component = resolve(v.componentKey)
        return (
          <Allotment.Pane
            key={v.id}
            minSize={isCollapsed ? HEADER_H : OPEN_MIN}
            maxSize={isCollapsed ? HEADER_H : Infinity}
          >
            <ViewPane
              viewId={v.id}
              title={v.name}
              open={!isCollapsed}
              onToggle={() => toggle(v.id)}
              toolbar={toolbarMap?.get(v.id)}
              draggable={v.canMoveView !== false}
              onDropView={(sourceViewId, position) => moveHere(sourceViewId, v.id, position)}
            >
              <div data-view-id={v.id} className={styles['viewBody']}>
                {Component ? <Component /> : <span className={styles['empty']}>{v.name}</span>}
              </div>
            </ViewPane>
          </Allotment.Pane>
        )
      })}
    </Allotment>
  )
}
