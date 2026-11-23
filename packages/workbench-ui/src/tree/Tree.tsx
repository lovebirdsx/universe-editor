/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tree — generic render-prop tree view.
 *
 *  Owns the structural concerns shared by every tree (Explorer / Scm / Search):
 *  the role="tree" focusable container, keyboard navigation, windowing above a
 *  row-count threshold and reveal-into-view scrolling. Row content — twistie,
 *  icon, label, inline actions, highlights — is entirely the view's job via
 *  `renderRow`. The view also owns per-row context menu / drag-and-drop.
 *
 *  The container is always the scroll element and the rows are always absolutely
 *  positioned inside a spacer; `virtualizationThreshold` only decides whether
 *  every row is rendered or just the visible window. Nothing about the DOM shape
 *  changes with the row count — an earlier design swapped the scroll container
 *  itself at the threshold, which lost the scroll position on every crossing.
 *
 *  The keyboard / selection logic is lifted verbatim from the original
 *  ExplorerView so behaviour is preserved across the refactor.
 *--------------------------------------------------------------------------------------------*/

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { VirtualList } from '../list/VirtualList.js'
import { LIST_PAGE_STEP, resolveIndexNavigation } from '../list/listKeyboard.js'
import { hasTrustworthyViewport } from '../list/scrollElementLayout.js'
import { createIndexListVimActions } from '../keybinding/vimIndexActions.js'
import { useScrollRestore, type IScrollStatePersister } from '../list/useScrollRestore.js'
import { useVimSurface } from '../keybinding/vim/vimSurfaceRegistry.js'
import { useVimSurfaceKey } from '../keybinding/vim/vimSurfaceId.js'
import { useStableCallback } from '../hooks/useStableCallback.js'
import { isOpenTargetEnter, markAsSingleton } from '@universe-editor/platform'
import { type IVisibleNode, type TreeModel } from './TreeModel.js'
import type { ITreeFocusSource } from './focusSeed.js'
import {
  dispatchKeyboardContextMenu,
  findRowElement,
  isKeyupContextMenuSupplement,
} from './keyboardContextMenu.js'
import { useTreeModel } from './useTreeModel.js'
import {
  cancelOwnerFrame,
  getOwnerResizeObserver,
  requestOwnerFrame,
  type OwnerFrame,
} from '../dom/ownerWindow.js'
import treeStyles from './Tree.module.css'

const DEFAULT_ROW_HEIGHT = 22
const DEFAULT_THRESHOLD = 200
const DEFAULT_INDENT_WIDTH = 12
const DEFAULT_INDENT_BASE = 6
const DEFAULT_MAX_STICKY_ROWS = 5
/** Slack rows on each side of the viewport in the visible-window report; mirrors VirtualList's overscan. */
const VISIBLE_OVERSCAN = 5

/**
 * Row ids are opaque to this component and routinely carry characters CSS gives
 * meaning to — an SCM key embeds a Windows path, whose backslashes read as
 * escape introducers and make an interpolated selector silently match nothing.
 * Matching the attribute value directly sidesteps CSS escaping altogether.
 */
const findRow = (root: HTMLElement, id: string): HTMLElement | null =>
  findRowElement(root, 'data-row-key', id)

export { isKeyboardContextMenu } from './keyboardContextMenu.js'

export interface ITreeActivateModifiers {
  readonly ctrl: boolean
  readonly meta: boolean
  readonly alt: boolean
}

export interface ITreeActivateOptions {
  /** True for a light "preview" open (single click / Space); false to pin (Enter). */
  readonly preview: boolean
  /**
   * Input that produced this activation. `preview` cannot tell a single click
   * from Space; views that treat them differently branch on this.
   */
  readonly source: 'pointer' | 'keyboard'
  /** Present only for Ctrl/Meta/Alt+Enter on a tree with `modifierActivation`. */
  readonly modifiers?: ITreeActivateModifiers
}

export interface ITreeRowRenderContext<T> {
  readonly node: IVisibleNode<T>
  readonly isSelected: boolean
  readonly isFocused: boolean
  /** Left padding in px derived from depth — apply to the row root. */
  readonly indentPadding: number
  /** Toggle this node's expansion (for an explicit twistie handler). */
  readonly onToggle: () => void
  /** Built-in row click: shift=range, ctrl/meta=toggle-in-selection, plain=select (+toggle dir / activate leaf). */
  readonly onClickRow: (e: ReactMouseEvent) => void
  /** Virtualization positioning style — pass through to the row root when present. */
  readonly style?: CSSProperties | undefined
}

/** Context for a pinned sticky-scroll row (see `renderStickyRow`). */
export interface ITreeStickyRowRenderContext<T> {
  readonly node: IVisibleNode<T>
  /** Left padding in px derived from depth — apply to the row root. */
  readonly indentPadding: number
}

export interface ITreeProps<T> {
  readonly model: TreeModel<T>
  /**
   * Row content. The React key is Tree's job, not yours — it wraps each row in a
   * keyed Fragment using `node.id`, so the row root needs no `key` of its own.
   */
  readonly renderRow: (ctx: ITreeRowRenderContext<T>) => ReactNode
  readonly rowHeight?: number
  /**
   * Per-row height for trees whose rows are not uniform (e.g. two-line entry
   * rows under one-line group headers). Returning undefined falls back to
   * `rowHeight`. Rows stay fixed-height — this only lets a tree use more than
   * one fixed height, it does not measure content.
   */
  readonly getRowHeight?: (node: IVisibleNode<T>) => number | undefined
  readonly virtualizationThreshold?: number
  readonly indentWidth?: number
  readonly indentBase?: number
  readonly className?: string
  readonly ariaLabel?: string
  /** Receives the tree container element (e.g. to register it as focusable). */
  readonly rootRef?: Ref<HTMLDivElement>
  /**
   * Activate a leaf (Enter / Space / plain click on a node without children).
   * `opts.source` distinguishes a plain click from Enter/Space.
   */
  readonly onActivate?: (node: IVisibleNode<T>, opts: ITreeActivateOptions) => void
  /**
   * Treat every row as activatable on Enter — including non-leaf rows, which
   * would otherwise toggle. Expand/collapse then lives entirely on Left/Right.
   * Used by Outline, where each symbol is a jump target (Explorer keeps the
   * default: Enter toggles a folder). Space still previews leaves either way.
   */
  readonly activateNonLeafOnEnter?: boolean
  /**
   * Opt in to Ctrl/Meta/Alt+Enter as a targeted activation of the focused row
   * (side open / new window). Those combos normally fall through to the global
   * keybinding handler; with this on, the tree calls `onActivate` with
   * `modifiers` instead — including for non-leaf rows, whose guard is the
   * view's job. Shift is deliberately excluded so Ctrl+Shift+Enter stays a
   * global binding.
   */
  readonly modifierActivation?: boolean
  /** Keys not handled by built-in navigation (e.g. F2 / Delete) reach the view here. */
  readonly onRowKeyDown?: (e: ReactKeyboardEvent, node: IVisibleNode<T>) => void
  /** Shift+Tab inside the tree — lets the view hand focus back to a prior region. */
  readonly onShiftTab?: () => void
  /** Context menu on empty area (null) — per-row menus are the view's job in renderRow. */
  readonly onContextMenu?: (e: ReactMouseEvent, node: IVisibleNode<T> | null) => void
  /** Called when the tree container receives DOM focus — before built-in focus state update.
   *  `source` is `'pointer'` when the focus came from this tree's mousedown handler,
   *  `'keyboard'` for Tab / programmatic focus. Seeding a cursor from a pointer
   *  focus must pass `{ reveal: false }` (see `seedTreeFocusCursor`): revealing
   *  would move the row out from under the still-pending mouseup/click. */
  readonly onFocus?: (source: ITreeFocusSource) => void
  /**
   * Reports which rows the scroll viewport covers: the slice of `visibleNodes`
   * spanning the viewport plus `VISIBLE_OVERSCAN` rows of slack on each side,
   * or an empty array when there is no viewport (the tree is hidden or not yet
   * laid out). Fires on scroll, container resize and structure changes, and
   * only when the window actually moves.
   *
   * A side-effect channel for on-demand work (e.g. resolving per-row state
   * through a query service) — NOT a render input: do not setState from it, or
   * scrolling would re-render the tree.
   */
  readonly onVisibleNodesChange?: (nodes: readonly IVisibleNode<T>[]) => void
  /**
   * Enables VSCode-style sticky scroll: the ancestor chain of the row at the
   * viewport's top edge is pinned there, one row per depth, so a scrolled
   * folder tree still shows which folders the visible rows live under.
   *
   * Pinned rows render through this hook instead of `renderRow` on purpose:
   * a copy of the real row would duplicate its `data-row-key` (breaking the
   * "one element per row key" invariant) and drag it into row handlers the
   * pin must not run. Render a presentation-only row — no `data-row-key`, no
   * `role`/`aria-*`, no drag or click handlers. Clicking a pinned row scrolls
   * its real row just below the pinned stack.
   */
  readonly renderStickyRow?: (ctx: ITreeStickyRowRenderContext<T>) => ReactNode
  /** Cap on simultaneously pinned rows (default 5); also capped at half the viewport. */
  readonly maxStickyRows?: number
  /**
   * Stable key identifying this logical view; when set, the tree's scroll
   * position is saved on unmount and restored on remount through
   * ScrollStateCache (survives container switches, not a window reload).
   */
  readonly scrollStateKey?: string
  /**
   * Custom scroll-position backing store (e.g. one that also mirrors to durable
   * storage so the position survives a window reload). Defaults to the
   * in-memory ScrollStateCache. Must be a stable object across renders.
   */
  readonly scrollStatePersister?: IScrollStatePersister
  /**
   * Stable view identity for Vim mode memory (`list:<vimSurfaceId>`). Omit for
   * a per-instance auto key.
   */
  readonly vimSurfaceId?: string | undefined
  /**
   * Vim `/` (`list.find`): open the view's own filter box. Only views with a
   * type-to-filter / find box pass it; without it `/` does nothing on this tree.
   */
  readonly onVimFind?: (() => void) | undefined
}

export function Tree<T>(props: ITreeProps<T>) {
  const {
    model,
    renderRow,
    rowHeight = DEFAULT_ROW_HEIGHT,
    getRowHeight,
    virtualizationThreshold = DEFAULT_THRESHOLD,
    indentWidth = DEFAULT_INDENT_WIDTH,
    indentBase = DEFAULT_INDENT_BASE,
    className,
    ariaLabel,
    rootRef,
    onActivate,
    onRowKeyDown,
    onShiftTab,
    onContextMenu,
    onFocus,
    onVisibleNodesChange,
    activateNonLeafOnEnter = false,
    modifierActivation = false,
    renderStickyRow,
    maxStickyRows = DEFAULT_MAX_STICKY_ROWS,
    scrollStateKey,
    scrollStatePersister,
    vimSurfaceId,
    onVimFind,
  } = props

  const { selectionVersion, structureVersion, visibleNodes } = useTreeModel(model)
  void selectionVersion // re-render on selection change so row flags stay fresh

  const [hasFocus, setHasFocus] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  // Set only while this tree's own mousedown handler is focusing the container:
  // focus() dispatches synchronously, so onFocus can classify the source before
  // this resets. A second focusin from a child control is not pointer focus.
  const pointerFocusRef = useRef(false)
  const visibleRef = useRef(visibleNodes)
  visibleRef.current = visibleNodes
  const vimSurfaceKey = useVimSurfaceKey('list', vimSurfaceId)

  // React attaches child refs before parent ones, so on the first render the
  // container does not exist yet and the virtualizer would find no scroll
  // element. Left alone it would attach on whichever later render happens to
  // come first — and attaching resets its scroll offset to 0, which is exactly
  // the jump this design removes. Holding the list back until the container
  // lands pins the attach to mount, when the position is 0 anyway.
  const [containerReady, setContainerReady] = useState(false)

  const setContainer = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el
      setContainerReady(el !== null)
      if (typeof rootRef === 'function') rootRef(el)
      else if (rootRef) (rootRef as { current: HTMLDivElement | null }).current = el
    },
    [rootRef],
  )

  // The container is the scroll element in every mode — VirtualList renders
  // into it rather than bringing its own.
  const getScrollElement = useCallback((): HTMLElement | null => containerRef.current, [])
  useScrollRestore(scrollStateKey, getScrollElement, scrollStatePersister)

  // Reveal: defer scroll to after commit.
  const [revealRequest, setRevealRequest] = useState<{
    id: string
    tick: number
    relativeTop?: number
  } | null>(null)
  useEffect(() => {
    // Singleton for the same reason as useTreeModel: a page-reload unmount runs
    // before passive cleanup flushes, which would otherwise leak-report this.
    const d = markAsSingleton(
      model.onReveal(({ id, relativeTop }) =>
        setRevealRequest((prev) => ({
          id,
          tick: (prev?.tick ?? 0) + 1,
          // exactOptionalPropertyTypes: omit the key rather than writing undefined.
          ...(relativeTop !== undefined ? { relativeTop } : {}),
        })),
      ),
    )
    return () => d.dispose()
  }, [model])

  // 行高：默认统一，视图给了 getRowHeight 则按行。解析器放 ref，函数身份恒定——虚拟化器并不按
  // estimateSize 身份缓存测量（getMeasurementOptions 只看 count / getItemKey 等），换身份换来的
  // 只是闭包链持有（见 useStableCallback）。
  const rowHeightRef = useRef({ rowHeight, getRowHeight })
  rowHeightRef.current = { rowHeight, getRowHeight }
  const sizeAt = useStableCallback((index: number): number => {
    const { rowHeight: fallback, getRowHeight: resolve } = rowHeightRef.current
    const node = visibleRef.current[index]
    return (node && resolve?.(node)) ?? fallback
  })

  const watchSticky = renderStickyRow !== undefined
  const maxStickyRowsRef = useRef(maxStickyRows)
  maxStickyRowsRef.current = maxStickyRows

  // Sticky geometry, shared by the pinned stack and reveal. The stack pins the
  // ancestor chain of the row at the viewport's top edge, so a revealed row has
  // to be scrolled below that band — top-aligning it puts it underneath the
  // pinned rows (VSCode's `reveal(..., paddingTop = nodePositionTopBelowWidget)`).
  const rowIndexAtOffset = useStableCallback((offset: number): number => {
    const nodes = visibleRef.current
    if (nodes.length === 0) return 0
    const { rowHeight: fallback, getRowHeight: resolve } = rowHeightRef.current
    if (resolve === undefined) {
      return Math.min(nodes.length - 1, Math.max(0, Math.floor(offset / fallback)))
    }
    let accumulated = 0
    for (let i = 0; i < nodes.length; i++) {
      const size = sizeAt(i)
      if (accumulated + size > offset) return i
      accumulated += size
    }
    return nodes.length - 1
  })

  /** Ancestor row indices of `index`, outermost first (root … parent). */
  const ancestorChain = useStableCallback((index: number): number[] => {
    const nodes = visibleRef.current
    const chain: number[] = []
    let wantDepth = (nodes[index]?.depth ?? 0) - 1
    for (let i = index - 1; i >= 0 && wantDepth >= 0; i--) {
      if (nodes[i]?.depth === wantDepth) {
        chain.unshift(i)
        wantDepth -= 1
      }
    }
    return chain
  })

  /**
   * The part of `chain` the overlay actually pins: innermost rows first, under
   * the row-count cap and the half-viewport cap. Returned outermost first.
   */
  const constrainPinned = useStableCallback(
    (chain: readonly number[], viewport: number): number[] => {
      const picked: number[] = []
      let height = 0
      const limit = Math.max(1, maxStickyRowsRef.current)
      for (let i = chain.length - 1; i >= 0; i--) {
        if (picked.length >= limit) break
        const index = chain[i]!
        const size = sizeAt(index)
        if (picked.length > 0 && height + size > viewport / 2) break
        picked.unshift(index)
        height += size
      }
      return picked
    },
  )

  const pinnedHeightForIndex = useStableCallback((index: number, viewport: number): number => {
    let height = 0
    for (const ancestor of constrainPinned(ancestorChain(index), viewport)) {
      height += sizeAt(ancestor)
    }
    return height
  })

  /**
   * Whether the pinned band exists at all — off for sticky-disabled trees, a
   * collapsed pane, or a pre-layout viewport (clientHeight spans the content).
   */
  const stickyBandAvailable = useStableCallback((viewport: number): boolean => {
    if (!watchSticky || viewport <= 0 || visibleRef.current.length === 0) return false
    const scroller = containerRef.current
    return scroller !== null && hasTrustworthyViewport(scroller)
  })

  const stickyBandHeight = useStableCallback((scrollTop: number, viewport: number): number =>
    stickyBandAvailable(viewport) ? pinnedHeightForIndex(rowIndexAtOffset(scrollTop), viewport) : 0,
  )

  /**
   * Scroll offset that puts `rowTop` below the pinned band. VSCode reserves the
   * target's own ancestor band; ours can be taller when a deeper subtree sits
   * above the target (the stack pins the top-edge row's chain), so recompute
   * against the band at the landing position until the row is clear of it.
   * Scrolling to the first row is always safe — its depth is 0, so nothing pins
   * there.
   */
  const scrollTopBelowSticky = useStableCallback(
    (
      rowTop: number,
      height: number,
      index: number,
      viewport: number,
      relativeTop?: number | undefined,
    ): number => {
      const anchor = relativeTop === undefined ? undefined : Math.min(1, Math.max(0, relativeTop))
      // VSCode's List.reveal: nearest-edge mode lands the row just below the
      // band; relativeTop anchors it that fraction down the area the pinned rows
      // leave visible (0.5 centers it in what remains).
      const place = (band: number): number =>
        anchor === undefined
          ? Math.max(0, rowTop - band)
          : Math.max(0, rowTop - band - (viewport - height - band) * anchor)
      if (!stickyBandAvailable(viewport)) {
        return anchor === undefined
          ? Math.max(0, rowTop)
          : Math.max(0, rowTop + (height - viewport) * anchor)
      }
      let next = place(pinnedHeightForIndex(index, viewport))
      for (let i = 0; i < 16 && next > 0; i++) {
        const band = stickyBandHeight(next, viewport)
        if (rowTop - next >= band) break
        const candidate = place(band)
        if (candidate >= next) break
        next = candidate
      }
      return next
    },
  )

  // Reveal scrolls this tree's own container. By default it moves the minimum
  // needed (nearest edge); a caller-supplied relativeTop (Explorer's
  // VSCode-parity reveal) instead places the row that fraction down the
  // viewport (0.5 = center). Both modes are no-ops when the row is already
  // fully visible. Geometry is computed from row offsets rather than delegated
  // to `element.scrollIntoView`, which also scrolls every ancestor scroller —
  // `overflow: hidden` boxes included, since script may scroll them — so
  // selecting a row could shift an outer container or the document and leave
  // the region the compositor had already rastered behind (double-exposed
  // rows). Geometry also covers the windowed case, where the target row has no
  // element to call it on.
  useLayoutEffect(() => {
    if (!revealRequest) return
    const { id, relativeTop } = revealRequest
    // The attempt can run before this frame's layout is computed (remount on a
    // container switch, reveal fired mid-commit): the scroller then still
    // reports a pre-layout clientHeight (up to the full content height), the
    // row looks "already visible", and the reveal is dropped with the tree
    // stuck at the top. Retry until one attempt actually scrolls, or the row
    // is confirmed visible against a laid-out viewport.
    let attempt = 0
    let cancelled = false
    let frame: OwnerFrame | undefined
    // A reveal request is a one-shot intent. Once the target row exists and a
    // laid-out viewport confirms it (or we scrolled to it), consume the request:
    // this effect also re-runs on every structureVersion bump (a row revealed
    // through a later expansion only shows up then), and an already-satisfied
    // request outliving that bump would re-apply itself against a scroll
    // position the user has changed since — the "click after scrolling yanks the
    // tree back to the seeded row" regression. Keep it armed only while the
    // target is absent or the viewport is not laid out yet.
    const settle = (): void => {
      setRevealRequest((prev) => (prev === revealRequest ? null : prev))
    }
    const tryScroll = (): void => {
      if (cancelled) return
      attempt += 1
      const scroller = containerRef.current
      if (!scroller) return
      const idx = visibleRef.current.findIndex((n) => n.id === id)
      if (idx < 0) return
      // Uniform-height trees (the overwhelming majority) get the O(1) offset;
      // only a per-row resolver forces the accumulating walk.
      let rowTop = rowHeight * idx
      if (getRowHeight) {
        rowTop = 0
        for (let i = 0; i < idx; i++) rowTop += sizeAt(i)
      }
      const height = sizeAt(idx)
      // No host pads its scroller (each is an unpadded flex column whose only child
      // is the spacer), so a row's offset inside the spacer is its offset in the
      // scroll range. A padded scroller would shift every reveal by that padding.
      const viewport = scroller.clientHeight
      const visibleTop = scroller.scrollTop
      if (viewport <= 0) {
        // Collapsed pane or pre-layout mount: there is no "nearest" edge to align
        // to, and nothing re-runs this once the pane is sized — put the row at the
        // top of the range rather than leaving the reveal unconsumed.
        scroller.scrollTop = Math.max(0, rowTop)
        settle()
        return
      }
      const visibleBottom = visibleTop + viewport
      // The pinned stack paints over the top of the viewport, so a row under it
      // is not visible even when its rect is inside the scroll box.
      const band = stickyBandHeight(visibleTop, viewport)
      const visibleTopUnderBand = visibleTop + band
      // VSCode's ExplorerView only reveals a row that is NOT fully visible;
      // check this before the relativeTop branch so centering never nudges a
      // row that is already entirely on screen.
      if (rowTop >= visibleTopUnderBand && rowTop + height <= visibleBottom) {
        // No scroll this attempt. If the viewport spans the whole content the
        // scroller is pre-layout (a real viewport is smaller); retry on the next
        // frame when layout has settled. A genuinely visible row confirms when
        // the retried attempt still needs no scroll.
        if (viewport >= scroller.scrollHeight && attempt < 10) {
          frame = requestOwnerFrame(scroller, tryScroll)
          return
        }
        settle()
        return
      }
      // Top-aligning the row would leave it underneath the pinned band, so both
      // modes reserve the band; relativeTop then anchors the row inside what
      // the band leaves visible. The lower bound is explicit because happy-dom
      // stores negative scrollTop verbatim; the upper bound is the browser's
      // job (scrollTop clamps to scrollHeight - clientHeight, since
      // scrollHeight is 0 in tests).
      const next =
        relativeTop === undefined
          ? rowTop < visibleTopUnderBand
            ? scrollTopBelowSticky(rowTop, height, idx, viewport)
            : rowTop + height - viewport
          : scrollTopBelowSticky(rowTop, height, idx, viewport, relativeTop)
      scroller.scrollTop = next
      settle()
    }
    tryScroll()
    return () => {
      cancelled = true
      cancelOwnerFrame(frame)
    }
    // sizeAt 身份恒定后必须显式依赖 structureVersion：只被展开带出来的目标行要等结构变化重跑；
    // 同一 id 的重复 reveal 仍由 revealRequest 里的 tick 触发。
  }, [
    revealRequest,
    structureVersion,
    sizeAt,
    rowHeight,
    getRowHeight,
    stickyBandHeight,
    scrollTopBelowSticky,
  ])

  // Visible-window reporting (see `onVisibleNodesChange`). The geometry is
  // derived here rather than read off the virtualizer: in the non-windowed mode
  // VirtualList renders every row and its total size is just the sum of
  // `estimateSize`, so the virtualizer's window is not the viewport there.
  const lastWindowRef = useRef<{
    nodes: readonly IVisibleNode<T>[]
    start: number
    end: number
  } | null>(null)
  const windowFrameRef = useRef<OwnerFrame | undefined>(undefined)

  const emitVisibleWindow = useStableCallback((): void => {
    const scroller = containerRef.current
    if (!scroller) return
    const nodes = visibleRef.current
    // A pre-layout clientHeight spans the whole content; reporting it would tell
    // the host that every row is visible. The existing ResizeObserver re-reports
    // once the pane is sized.
    const viewport = hasTrustworthyViewport(scroller) ? scroller.clientHeight : 0
    let start = 0
    let end = -1
    if (viewport > 0 && nodes.length > 0) {
      const top = scroller.scrollTop
      const bottom = top + viewport
      const { rowHeight: fallback, getRowHeight: resolve } = rowHeightRef.current
      let first = -1
      let last = -1
      if (resolve === undefined) {
        // Uniform rows: O(1).
        first = Math.floor(top / fallback)
        last = Math.min(nodes.length - 1, Math.ceil(bottom / fallback) - 1)
      } else {
        // Per-row heights: accumulate, same walk as the reveal path above.
        let offset = 0
        for (let i = 0; i < nodes.length; i++) {
          const size = sizeAt(i)
          if (first < 0 && offset + size > top) first = i
          if (offset >= bottom) break
          last = i
          offset += size
        }
      }
      if (first >= 0) {
        start = Math.max(0, first - VISIBLE_OVERSCAN)
        end = Math.min(nodes.length - 1, last + VISIBLE_OVERSCAN)
      }
    }
    const previous = lastWindowRef.current
    // The de-dupe key includes the nodes array identity: useTreeModel re-derives
    // it per structure version, so an unchanged index range over a changed tree
    // is a different window and must be re-reported.
    if (
      previous !== null &&
      previous.nodes === nodes &&
      previous.start === start &&
      previous.end === end
    ) {
      return
    }
    lastWindowRef.current = { nodes, start, end }
    onVisibleNodesChange?.(nodes.slice(start, end + 1))
  })

  const scheduleVisibleWindow = useStableCallback((): void => {
    if (windowFrameRef.current !== undefined) return
    const scroller = containerRef.current
    if (!scroller) return
    windowFrameRef.current = requestOwnerFrame(scroller, () => {
      windowFrameRef.current = undefined
      emitVisibleWindow()
    })
  })

  const watchVisibleWindow = onVisibleNodesChange !== undefined

  // Sticky scroll: resolve the ancestor chain of the row at the viewport's top
  // edge from visible depths — a parent is the nearest preceding row one level
  // up. State only moves when the chain itself changes, so scrolling inside one
  // row never re-renders the tree.
  const [stickyIds, setStickyIds] = useState<readonly string[]>([])
  const stickyKeyRef = useRef('')
  const stickyFrameRef = useRef<OwnerFrame | undefined>(undefined)

  const measureSticky = useStableCallback((): void => {
    const scroller = containerRef.current
    const nodes = visibleRef.current
    let next: readonly string[] = []
    // Same pre-layout guard as the visible-window report: a clientHeight that
    // spans the whole content is not a viewport.
    if (scroller && nodes.length > 0 && hasTrustworthyViewport(scroller)) {
      const viewport = scroller.clientHeight
      if (viewport > 0) {
        const picked = constrainPinned(
          ancestorChain(rowIndexAtOffset(scroller.scrollTop)),
          viewport,
        )
        next = picked.flatMap((index) => {
          const node = nodes[index]
          return node === undefined ? [] : [node.id]
        })
      }
    }
    const key = next.join('\n')
    if (key === stickyKeyRef.current) return
    stickyKeyRef.current = key
    setStickyIds(next)
  })

  const scheduleSticky = useStableCallback((): void => {
    if (stickyFrameRef.current !== undefined) return
    const scroller = containerRef.current
    if (!scroller) return
    stickyFrameRef.current = requestOwnerFrame(scroller, () => {
      stickyFrameRef.current = undefined
      measureSticky()
    })
  })

  useEffect(() => {
    if (!watchSticky) return
    const scroller = containerRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', scheduleSticky, { passive: true })
    // A resize moves the top edge without scrolling, and is the only signal
    // when a hidden pane (no viewport) comes back.
    const ResizeObserverCtor = getOwnerResizeObserver(scroller)
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(scheduleSticky) : null
    observer?.observe(scroller)
    scheduleSticky()
    return () => {
      scroller.removeEventListener('scroll', scheduleSticky)
      observer?.disconnect()
      cancelOwnerFrame(stickyFrameRef.current)
      stickyFrameRef.current = undefined
      stickyKeyRef.current = ''
    }
  }, [watchSticky, scheduleSticky])

  // Structure changes move the rows under the top edge (expand / collapse /
  // reload), and no scroll event follows.
  useEffect(() => {
    if (watchSticky) scheduleSticky()
  }, [watchSticky, visibleNodes, scheduleSticky])

  // Jumping back is a plain scroll of this tree's own scroller (same geometry
  // as the reveal path — never `scrollIntoView`, which would move ancestors).
  const jumpToSticky = useStableCallback((id: string): void => {
    const scroller = containerRef.current
    if (!scroller) return
    const index = visibleRef.current.findIndex((node) => node.id === id)
    if (index < 0) return
    const { rowHeight: fallback, getRowHeight: resolve } = rowHeightRef.current
    let top = fallback * index
    if (resolve !== undefined) {
      top = 0
      for (let i = 0; i < index; i++) top += sizeAt(i)
    }
    // Land below the pinned stack instead of on the top edge, where the stack
    // would cover the real row.
    scroller.scrollTop = scrollTopBelowSticky(top, sizeAt(index), index, scroller.clientHeight)
  })

  useEffect(() => {
    if (!watchVisibleWindow) return
    // The ref callback runs before effects, so the container is always there on
    // the render that first asks for the window.
    const scroller = containerRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', scheduleVisibleWindow, { passive: true })
    // A resize fires no scroll event, and it is the only signal when a hidden
    // pane (clientHeight 0, reported as "no rows") comes back.
    const ResizeObserverCtor = getOwnerResizeObserver(scroller)
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(scheduleVisibleWindow) : null
    observer?.observe(scroller)
    // The first read is deferred a frame: layout is not committed at mount, and
    // a pre-layout clientHeight can span the whole content (the trap the reveal
    // path documents above).
    scheduleVisibleWindow()
    return () => {
      scroller.removeEventListener('scroll', scheduleVisibleWindow)
      observer?.disconnect()
      cancelOwnerFrame(windowFrameRef.current)
      windowFrameRef.current = undefined
      // Forget the last report: a host that toggles the prop off and on must not
      // have the re-attached window suppressed by a stale de-dupe key.
      lastWindowRef.current = null
    }
  }, [watchVisibleWindow, scheduleVisibleWindow])

  // Structure changes move rows (and can add or remove them) — re-report. Row
  // height props are treated as static; only the nodes are tracked here.
  useEffect(() => {
    if (watchVisibleWindow) scheduleVisibleWindow()
  }, [watchVisibleWindow, visibleNodes, scheduleVisibleWindow])

  // Keyboard context menu (ContextMenu key / Shift+F10): anchored on the focused
  // row so each view's existing row handler opens the menu exactly like a mouse
  // right-click. See `keyboardContextMenu.ts` for why the event is marked.
  const openKeyboardContextMenu = useCallback((node: IVisibleNode<T> | null) => {
    const root = containerRef.current
    if (!root) return
    const row = node ? findRow(root, node.id) : null
    dispatchKeyboardContextMenu(row ?? root, row !== null)
  }, [])

  // Bare Vim keys arrive as commands from the workbench dispatcher. Movement
  // counts resolve to one target index (one selection change / reveal); Left /
  // Right keep their structural meaning (collapse-then-parent, expand-then-
  // child) and therefore apply once per stroke. Ctrl+J/K/H/L are deliberately
  // not claimed: they keep their global workbench meaning (toggle panel / chord
  // leader / replace / expand-line-selection), and movement uses the bare keys
  // above or the arrow keys.
  const focusedVisibleIndex = (): number => {
    const focusedId = model.focused
    return focusedId ? model.getVisibleNodes().findIndex((n) => n.id === focusedId) : -1
  }
  const listActions = createIndexListVimActions({
    getCount: () => model.getVisibleNodes().length,
    getIndex: focusedVisibleIndex,
    setIndex: (index) => {
      const target = model.getVisibleNodes()[index]
      if (target) model.setSelection([target.id], target.id)
    },
    scroller: {
      getElement: () => containerRef.current,
      getRowHeight: () => {
        const current = model.getVisibleNodes().find((node) => node.id === model.focused)
        const { rowHeight: fallback, getRowHeight: resolve } = rowHeightRef.current
        return (current === undefined ? undefined : resolve?.(current)) ?? fallback
      },
    },
  })

  useVimSurface({
    id: vimSurfaceKey,
    kind: 'list',
    focus: 'within',
    getElement: () => containerRef.current,
    getSurfaceKey: () => vimSurfaceKey,
    defaultMode: 'normal',
    actions: {
      ...listActions,
      move: (direction, count) => {
        if (direction === 'left' || direction === 'right') model.navigate(direction)
        else listActions.move(direction, count)
      },
      expand: () => {
        const vis = model.getVisibleNodes()
        const current = vis.find((n) => n.id === model.focused)
        if (current?.hasChildren === true && !current.expanded) void model.expand(current.element)
      },
      collapse: () => model.navigate('left'),
      toggle: () => {
        const vis = model.getVisibleNodes()
        const current = vis.find((n) => n.id === model.focused)
        if (current?.hasChildren === true) void model.toggle(current.element)
      },
      activate: (_count, preview) => {
        const vis = model.getVisibleNodes()
        const current = vis.find((n) => n.id === model.focused)
        if (current === undefined) return
        if (current.hasChildren && (!activateNonLeafOnEnter || preview)) {
          void model.toggle(current.element)
          return
        }
        onActivate?.(current, { preview, source: 'keyboard' })
      },
      contextMenu: () => {
        const current = model.getVisibleNodes().find((n) => n.id === model.focused)
        openKeyboardContextMenu(current ?? null)
      },
      escape: () => model.collapseSelectionToFocus(),
      ...(onVimFind === undefined ? {} : { find: onVimFind }),
    },
  })

  // 身份恒定、body 最新：返回的行处理器每次调用现造（读到当前 model / onActivate），
  // 工厂自身不钉住产出旧一代行的渲染帧。
  const makeClickHandler = useStableCallback((node: IVisibleNode<T>) => (e: ReactMouseEvent) => {
    if (e.shiftKey) {
      model.extendSelectionTo(node.id)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      model.toggleInSelection(node.id)
      return
    }
    model.setSelection([node.id], node.id)
    if (node.hasChildren) void model.toggle(node.element)
    else onActivate?.(node, { preview: true, source: 'pointer' })
  })

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (modifierActivation && isOpenTargetEnter(e)) {
        const vis = model.getVisibleNodes()
        const focusedId = model.focused
        const current = focusedId ? vis.find((n) => n.id === focusedId) : undefined
        if (current && onActivate) {
          e.preventDefault()
          e.stopPropagation()
          onActivate(current, {
            preview: false,
            source: 'keyboard',
            modifiers: { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey },
          })
        }
        return
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key === 'Tab' && e.shiftKey && onShiftTab) {
        e.preventDefault()
        e.stopPropagation()
        onShiftTab()
        return
      }
      const vis = model.getVisibleNodes()
      if (vis.length === 0) return
      const focusedId = model.focused
      const currentIndex = focusedId ? vis.findIndex((n) => n.id === focusedId) : -1
      const current = currentIndex >= 0 ? vis[currentIndex] : undefined

      const handled = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      const moveTo = (index: number) => {
        const clamped = Math.max(0, Math.min(vis.length - 1, index))
        const target = vis[clamped]
        if (!target) return
        if (e.shiftKey) model.extendSelectionTo(target.id)
        else model.setSelection([target.id], target.id)
      }

      switch (e.key) {
        case 'ArrowDown':
          handled()
          model.navigate('down', e.shiftKey)
          return
        case 'ArrowUp':
          handled()
          model.navigate('up', e.shiftKey)
          return
        case 'Home':
        case 'End':
        case 'PageDown':
        case 'PageUp': {
          // Pure index arithmetic — shared with flat lists so both stay in step.
          const next = resolveIndexNavigation(e.key, {
            index: currentIndex,
            count: vis.length,
            pageSize: LIST_PAGE_STEP,
          })
          if (next === undefined) return
          handled()
          moveTo(next)
          return
        }
        case 'ArrowRight':
          if (!current) return
          handled()
          model.navigate('right')
          return
        case 'ArrowLeft':
          if (!current) return
          handled()
          model.navigate('left')
          return
        case 'Enter':
          if (!current) return
          handled()
          if (current.hasChildren && !activateNonLeafOnEnter) void model.toggle(current.element)
          else onActivate?.(current, { preview: false, source: 'keyboard' })
          return
        case ' ':
          if (!current) return
          handled()
          if (current.hasChildren) void model.toggle(current.element)
          else onActivate?.(current, { preview: true, source: 'keyboard' })
          return
        case 'ContextMenu':
          handled()
          if (!e.repeat) openKeyboardContextMenu(current ?? null)
          return
        case 'F10':
          if (e.shiftKey) {
            handled()
            if (!e.repeat) openKeyboardContextMenu(current ?? null)
            return
          }
        // plain F10 falls through so onRowKeyDown keeps seeing it
        default:
          if (current) onRowKeyDown?.(e, current)
          return
      }
    },
    [
      model,
      onActivate,
      onRowKeyDown,
      onShiftTab,
      activateNonLeafOnEnter,
      modifierActivation,
      openKeyboardContextMenu,
    ],
  )

  // The React key for every row is owned here rather than by the view. Tree holds
  // the only correct identity (`node.id`), and VirtualList's default branch
  // returns renderItem's result verbatim — so a view that forgot its own key got
  // a "unique key prop" warning plus positional reconciliation. A Fragment adds
  // no DOM node, so row markup is unchanged.
  const renderNode = (node: IVisibleNode<T>, style?: CSSProperties): ReactNode => (
    <Fragment key={node.id}>
      {renderRow({
        node,
        isSelected: model.isSelected(node.id),
        isFocused: model.focused === node.id,
        indentPadding: node.depth * indentWidth + indentBase,
        onToggle: () => void model.toggle(node.element),
        onClickRow: makeClickHandler(node),
        style,
      })}
    </Fragment>
  )

  // Resolve the pinned chain against the current visible rows on every render:
  // ids recorded by a rAF can outlive the structure that produced them.
  const stickyRows: { node: IVisibleNode<T>; indentPadding: number; height: number }[] = []
  if (watchSticky) {
    for (const id of stickyIds) {
      const index = visibleNodes.findIndex((node) => node.id === id)
      const node = index >= 0 ? visibleNodes[index] : undefined
      if (node === undefined) continue
      stickyRows.push({
        node,
        indentPadding: node.depth * indentWidth + indentBase,
        height: sizeAt(index),
      })
    }
  }

  return (
    <div
      ref={setContainer}
      className={className}
      role="tree"
      aria-label={ariaLabel}
      tabIndex={0}
      data-focused={hasFocus}
      onKeyDown={onKeyDown}
      onMouseDown={() => {
        pointerFocusRef.current = true
        containerRef.current?.focus({ preventScroll: true })
        pointerFocusRef.current = false
      }}
      onFocus={() => {
        setHasFocus(true)
        const source: ITreeFocusSource = pointerFocusRef.current ? 'pointer' : 'keyboard'
        pointerFocusRef.current = false
        onFocus?.(source)
      }}
      onBlur={() => setHasFocus(false)}
      {...(onContextMenu
        ? {
            onContextMenu: (e: ReactMouseEvent) => {
              if (isKeyupContextMenuSupplement(e)) {
                e.preventDefault()
                return
              }
              onContextMenu(e, null)
            },
          }
        : {})}
    >
      {stickyRows.length > 0 && renderStickyRow !== undefined && (
        <div className={treeStyles['stickyOverlay']} aria-hidden="true">
          <div className={treeStyles['stickyStack']}>
            {stickyRows.map(({ node, indentPadding, height }) => (
              <div
                key={node.id}
                className={treeStyles['stickyRow']}
                style={{ height: `${height}px` }}
                data-testid="tree-sticky-row"
                onClick={() => jumpToSticky(node.id)}
              >
                <div className={treeStyles['stickyRowContent']} inert={true}>
                  {renderStickyRow({ node, indentPadding })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {containerReady && (
        <VirtualList
          items={visibleNodes}
          estimateSize={sizeAt}
          scrollElementRef={containerRef}
          windowed={visibleNodes.length > virtualizationThreshold}
          renderItem={(node, style) => renderNode(node, style)}
        />
      )}
    </div>
  )
}
