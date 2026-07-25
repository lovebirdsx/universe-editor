import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
  type ReactNode,
} from 'react'
import { Allotment, type AllotmentHandle } from 'allotment'
import 'allotment/dist/style.css'
import type { IViewDescriptor } from '@universe-editor/platform'
import { ViewPane } from './ViewPane.js'
import { ViewToolbarRegistry } from '../../services/views/ViewComponentRegistry.js'
import {
  computeToggleSizes,
  initialPaneSize,
  VIEW_HEADER_SIZE as HEADER_H,
  VIEW_OPEN_MIN as OPEN_MIN,
} from '../../services/views/viewPaneLayout.js'
import { useViewDescriptors } from '../dnd/useViewDescriptors.js'
import { dragContainsView, viewDragData, type ViewDragPayload } from '../dnd/viewDragData.js'
import { applyViewDrop } from '../dnd/applyViewDrop.js'
import '../layout/allotment-theme.css'
import styles from '../paneComposite/PaneComposite.module.css'

interface Props {
  containerId: string
  views: readonly IViewDescriptor[]
  resolve: (componentKey: string) => ComponentType | undefined
  emptyMessage?: string
}

/**
 * Stacks a container's views as collapsible, resizable panes (VSCode PaneView):
 * collapsed panes shrink to their 28-px header and yield space to the open ones;
 * adjacent open panes are resizable via the sashes between them. Collapse and
 * size are persisted through IViewDescriptorService; views can be dragged within
 * and across containers.
 *
 * The whole container is also a drop target for *merging* into it: dropping a
 * view from another container, or a whole container's activity-bar icon / tab,
 * folds the dragged views in (a translucent overlay marks the target). Within a
 * multi-view container, fine-grained view re-ordering is left to each ViewPane's
 * before/after insertion line instead.
 */
export function ViewPaneContainer({
  containerId,
  views,
  resolve,
  emptyMessage = 'No views registered.',
}: Props) {
  const viewDescriptors = useViewDescriptors()
  const allotmentRef = useRef<AllotmentHandle>(null)
  const sizesRef = useRef<number[]>([])
  const [mergeActive, setMergeActive] = useState(false)

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

  // After a collapse/expand toggle, re-distribute sizes VSCode-style: a collapsed
  // pane shrinks to its header and hands the freed space to the bottom-most open
  // pane; an expanded pane restores its persisted size, taken back from the other
  // open panes bottom-up (see services/views/viewPaneLayout.ts). Only run when
  // the view *set* is unchanged: on add/remove/replace (e.g. a view dragged in or
  // out) the keyed Allotment remounts, and its new SplitView stays empty until the
  // next ResizeObserver tick + reconcile — a window spanning several commits, so a
  // later collapse (e.g. per-workspace state rehydrating right after a workspace
  // switch) can still land inside it. Dropping the stale sizes forces the
  // length guard below to keep skipping until the remounted instance reports
  // its real geometry via onChange.
  const collapsedKey = views.map((v) => (collapsed(v.id) ? '1' : '0')).join('')
  const viewIdsKey = views.map((v) => v.id).join('\n')
  const prevViewIdsRef = useRef(viewIdsKey)
  const prevCollapsedKeyRef = useRef(collapsedKey)
  // Expanded size remembered at collapse time. Allotment reconciles prop changes
  // in its own (child) layout effect before ours runs and fires onChange with the
  // pane clamped to its min — on expand that clobbers the persisted size before we
  // can read it. The snapshot taken at collapse time is safe because collapsed
  // panes are never written to the persisted state (see onChange below).
  const expandedSizesRef = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const handle = allotmentRef.current
    const sameViewSet = prevViewIdsRef.current === viewIdsKey
    const prevCollapsedKey = prevCollapsedKeyRef.current
    prevViewIdsRef.current = viewIdsKey
    prevCollapsedKeyRef.current = collapsedKey
    if (!handle || !sameViewSet) {
      sizesRef.current = []
      return
    }
    const sizes = sizesRef.current
    if (sizes.length !== views.length) return
    const collapsedFlags = views.map((v) => collapsed(v.id))
    let working = [...sizes]
    for (let i = 0; i < collapsedKey.length; i++) {
      if (collapsedKey[i] === prevCollapsedKey[i]) continue
      const viewId = views[i]!.id
      let restoreSize: number | undefined
      if (collapsedFlags[i]) {
        const remembered = viewDescriptors.getViewState(viewId).size ?? working[i]
        if (remembered !== undefined) expandedSizesRef.current.set(viewId, remembered)
      } else {
        restoreSize =
          expandedSizesRef.current.get(viewId) ?? viewDescriptors.getViewState(viewId).size
      }
      const next = computeToggleSizes({
        sizes: working,
        collapsed: collapsedFlags,
        toggledIndex: i,
        ...(restoreSize !== undefined ? { restoreSize } : {}),
      })
      if (next) working = next
    }
    handle.resize(working)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsedKey, viewIdsKey])

  // A drag that this container would *merge* in: another container's icon/tab, or
  // a view from another container. A multi-view container leaves single-view
  // placement to its ViewPanes' before/after lines, so it ignores view payloads
  // here and only takes whole-container merges.
  const mergePayload = (e: DragEvent): ViewDragPayload | undefined => {
    if (!dragContainsView(e.dataTransfer)) return undefined
    const payload = viewDragData.get()
    if (!payload) return undefined
    if (payload.kind === 'container') {
      return payload.id === containerId ? undefined : payload
    }
    if (views.length > 1) return undefined
    const sameContainer = viewDescriptors.getViewContainerByViewId(payload.id)?.id === containerId
    return sameContainer ? undefined : payload
  }

  const onMergeDragOver = (e: DragEvent) => {
    if (!mergePayload(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!mergeActive) setMergeActive(true)
  }

  const onMergeDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMergeActive(false)
  }

  const onMergeDrop = (e: DragEvent) => {
    const payload = mergePayload(e)
    setMergeActive(false)
    if (!payload) return
    e.preventDefault()
    applyViewDrop(viewDescriptors, payload, {
      kind: 'container',
      containerId,
      merge: payload.kind === 'container',
    })
  }

  let body: ReactNode
  if (views.length === 0) {
    body = (
      <div className={styles['emptyDrop']}>
        <p className={styles['empty']}>{emptyMessage}</p>
      </div>
    )
  } else if (views.length === 1) {
    const v = views[0]!
    const Component = resolve(v.componentKey)
    body = (
      <div data-view-id={v.id} className={styles['viewBody']} style={{ flex: 1, minHeight: 0 }}>
        {Component ? <Component /> : <span className={styles['empty']}>{v.name}</span>}
      </div>
    )
  } else {
    body = (
      <Allotment
        // Keying on the view order forces a fresh Allotment on any reorder. Its
        // pure-reorder reconciliation (v1.20.x) moves internal viewItems but
        // leaves the parallel per-pane min/max descriptors + previous-keys in the
        // old order, so a later collapse/expand applies size constraints to the
        // wrong pane (expanded view pinned to its header, collapsed sibling fills
        // the container). Remounting rebuilds all three arrays consistently;
        // collapse/expand keeps the same key and still animates in place.
        key={viewIdsKey}
        ref={allotmentRef}
        className={styles['paneContainerAllotment'] ?? ''}
        vertical
        onChange={(s) => {
          sizesRef.current = s
          // Collapsed panes report their header height here; persist only the
          // expanded panes' sizes so a collapsed pane keeps its remembered
          // expanded size for later restore (across reloads too).
          viewDescriptors.setViewSizes(
            views.flatMap((v, i) => (collapsed(v.id) ? [] : [{ id: v.id, size: s[i] ?? 0 }])),
          )
        }}
      >
        {views.map((v) => {
          const isCollapsed = collapsed(v.id)
          const preferredSize = initialPaneSize(
            isCollapsed,
            viewDescriptors.getViewState(v.id).size,
          )
          const Component = resolve(v.componentKey)
          return (
            <Allotment.Pane
              key={v.id}
              minSize={isCollapsed ? HEADER_H : OPEN_MIN}
              maxSize={isCollapsed ? HEADER_H : Infinity}
              {...(preferredSize !== undefined ? { preferredSize } : {})}
            >
              <ViewPane
                viewId={v.id}
                title={v.name}
                open={!isCollapsed}
                onToggle={() => toggle(v.id)}
                toolbar={ViewToolbarRegistry.get(v.id)}
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

  return (
    <div
      className={styles['paneContainer']}
      data-container-drop={containerId}
      onDragOver={onMergeDragOver}
      onDragLeave={onMergeDragLeave}
      onDrop={onMergeDrop}
    >
      {body}
      {mergeActive ? (
        <div
          className={styles['mergeOverlay']}
          data-testid={`view-merge-overlay-${containerId}`}
          aria-hidden="true"
        />
      ) : null}
    </div>
  )
}
