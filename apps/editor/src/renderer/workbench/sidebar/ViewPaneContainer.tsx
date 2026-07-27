import {
  useEffect,
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
 * Grace window for applying reconciled WORKSPACE sizes after the first real
 * layout: main.tsx's reconcileFromStorage() gives up waiting for workspace
 * hydration after this many ms (INITIAL_LOAD_TIMEOUT_MS in
 * ViewDescriptorService), so beyond it a first-layout correction would fight
 * the default equal split the user may already be watching.
 */
const RECONCILE_GRACE_MS = 500 + 100

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
        // Remember the expanded size: prefer the authoritative persisted value
        // — the live view state may hold layout noise (greedy first-layout
        // split) even though the visible panes were already corrected back.
        const remembered =
          viewDescriptors.getPersistedViewSize(viewId) ??
          viewDescriptors.getViewState(viewId).size ??
          working[i]
        if (remembered !== undefined) {
          expandedSizesRef.current.set(viewId, remembered)
          // Collapsing is a user action: keep the expanded size on disk (the
          // header height the collapsed pane reports must never be persisted).
          viewDescriptors.setViewSizes([{ id: viewId, size: remembered }], { persist: true })
        }
      } else {
        restoreSize =
          expandedSizesRef.current.get(viewId) ??
          viewDescriptors.getPersistedViewSize(viewId) ??
          viewDescriptors.getViewState(viewId).size
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

  // Persisted per-view sizes can be reconciled from WORKSPACE storage AFTER
  // Allotment's first real layout — main.tsx defers that reconcile off the
  // first-paint path, while Allotment's ResizeObserver fires independently as
  // soon as the container has a size (same race WorkbenchLayout corrects for
  // the top-level sidebar/panel/secondary sizes). A mounted pane's
  // preferredSize prop change is bookkeeping-only (allotment freezes each
  // pane's layoutStrategy at construction), so a late reconcile must be
  // applied imperatively. Corrections run on every onChange report inside the
  // startup settle window (a single one-shot correction loses to a later
  // greedy redistribution — Allotment's initial distributeEmptySpace can pin
  // a pane to its min when the window's own geometry settle re-layouts the
  // container) and on the stored-sizes key change below; a user sash drag
  // cancels them.
  const isLayoutSettledRef = useRef(false)
  const userDraggedRef = useRef(false)
  // Set on drag *start* (not only drag-end): an in-flight sash gesture blocks
  // every persisted-size correction — applying one mid-drag fights the live
  // drag stream and can leave the panes frozen at the pre-drag split.
  const sashDraggingRef = useRef(false)
  const layoutSettleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    layoutSettleTimerRef.current = setTimeout(() => {
      isLayoutSettledRef.current = true
    }, RECONCILE_GRACE_MS)
    return () => clearTimeout(layoutSettleTimerRef.current)
  }, [])
  // The restore target is the *persisted* size map, not the live view state:
  // Allotment's greedy first layout can report a degenerate split (one pane
  // pinned to its min — see WorkbenchLayout's note on distributeEmptySpace),
  // and the onChange bookkeeping below would then overwrite the live state
  // with it. A later unrelated render would read that polluted value back as
  // the "stored" size and resize the panes to the degenerate split for good.
  // Reentrancy guard: a corrective resize() fires onChange synchronously, and
  // re-entering the correction from that nested report could recurse (or ping
  // -pong when the container is smaller than the persisted total).
  const correctingRef = useRef(false)
  const correctToStoredSizes = (sizes: readonly number[]) => {
    if (sashDraggingRef.current || correctingRef.current) return
    if (sizes.length !== views.length) return
    // With a collapsed pane the split is owned by the toggle effect above
    // (collapsed pane pinned to its header, the open panes absorb the rest) —
    // a persisted-size correction would fight that distribution.
    if (views.some((v) => collapsed(v.id))) return
    // Keep the container's current total: only re-distribute it among the
    // panes (VSCode sash semantics — a sash move never changes the container
    // size). Scaling a persisted total down into a smaller container gets
    // clamped by Allotment and the correction would chase its own clamp
    // forever; growing to a stale larger total would fight the container.
    const total = sizes.reduce((sum, size) => sum + (size ?? 0), 0)
    const bases = views.map((v, i) =>
      Math.max(OPEN_MIN, viewDescriptors.getPersistedViewSize(v.id) ?? sizes[i] ?? OPEN_MIN),
    )
    const baseSum = bases.reduce((sum, size) => sum + size, 0)
    const deficit = total - baseSum
    // Container smaller than the persisted total: stay out — Allotment's own
    // clamped distribution is the reasonable one, and chasing absolute sizes
    // into it would loop resize→clamp→report→resize. When the container grows
    // to fit (startup geometry settle), the next report corrects the split.
    if (deficit < 0) return
    // Hand any extra room (container taller than the persisted total) to the
    // bottom-most pane, mirroring the greedy SplitView distribution.
    const target = bases.map((size, i) => (i === bases.length - 1 ? size + deficit : size))
    if (target.some((size, i) => Math.abs(size - (sizes[i] ?? 0)) > 1)) {
      correctingRef.current = true
      try {
        allotmentRef.current?.resize(target)
      } finally {
        correctingRef.current = false
      }
    }
  }
  // A reconcile landing AFTER the first layout surfaces as a stored-sizes key
  // change (reconcileFromStorage bumps the version): correct the split. The
  // key is consumed only once the mounted Allotment has reported real geometry
  // — before that the first-onChange correction above owns the window.
  const storedSizesKey = views
    .map((v) => (collapsed(v.id) ? '' : String(viewDescriptors.getPersistedViewSize(v.id) ?? '')))
    .join('|')
  const prevStoredSizesKeyRef = useRef(storedSizesKey)
  useLayoutEffect(() => {
    const prevKey = prevStoredSizesKeyRef.current
    const handle = allotmentRef.current
    const sizes = sizesRef.current
    if (!handle || prevKey === storedSizesKey || sizes.length !== views.length) return
    prevStoredSizesKeyRef.current = storedSizesKey
    correctToStoredSizes(sizes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedSizesKey])

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
          // Correct toward the persisted sizes on EVERY report inside the
          // startup settle window, not just the first: Allotment's greedy
          // first-layout distribution (a pane pinned to its min, see
          // WorkbenchLayout's distributeEmptySpace note) can also land AFTER
          // an earlier correction — e.g. the window's own startup geometry
          // settle re-layouts the container a second time — with no further
          // stored-sizes key change to retrigger the effect above. A user
          // sash drag takes precedence (sashDraggingRef / userDraggedRef).
          if (!isLayoutSettledRef.current && !userDraggedRef.current) correctToStoredSizes(s)
          // In-memory bookkeeping only (drives collapse/expand restore math
          // and the collapse-time remembered-size snapshot). Persisting here
          // would let layout noise — notably the pre-reconcile equal split —
          // clobber the user's dragged sizes on disk within the save debounce
          // window; user changes persist via onDragEnd below (VSCode
          // semantics: container resizes and programmatic corrections never
          // overwrite the user's chosen sizes).
          viewDescriptors.setViewSizes(
            views.flatMap((v, i) => (collapsed(v.id) ? [] : [{ id: v.id, size: s[i] ?? 0 }])),
          )
        }}
        onDragStart={() => {
          sashDraggingRef.current = true
        }}
        onDragEnd={(s) => {
          sashDraggingRef.current = false
          userDraggedRef.current = true
          // Collapsed panes report their header height here; persist only the
          // expanded panes' sizes so a collapsed pane keeps its remembered
          // expanded size for later restore (across reloads too).
          viewDescriptors.setViewSizes(
            views.flatMap((v, i) => (collapsed(v.id) ? [] : [{ id: v.id, size: s[i] ?? 0 }])),
            { persist: true },
          )
        }}
      >
        {views.map((v) => {
          const isCollapsed = collapsed(v.id)
          const preferredSize = initialPaneSize(
            isCollapsed,
            viewDescriptors.getPersistedViewSize(v.id) ?? viewDescriptors.getViewState(v.id).size,
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
