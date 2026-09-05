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
import { VirtualList, type VirtualListHandle } from '../list/VirtualList.js'
import { useScrollRestore, type IScrollStatePersister } from '../list/useScrollRestore.js'
import { markAsSingleton } from '@universe-editor/platform'
import { type IVisibleNode, type TreeModel } from './TreeModel.js'
import { useTreeModel } from './useTreeModel.js'

const PAGE_STEP = 10
const DEFAULT_ROW_HEIGHT = 22
const DEFAULT_THRESHOLD = 200
const DEFAULT_INDENT_WIDTH = 12
const DEFAULT_INDENT_BASE = 6

export interface ITreeActivateOptions {
  /** True for a light "preview" open (single click / Space); false to pin (Enter). */
  readonly preview: boolean
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

export interface ITreeProps<T> {
  readonly model: TreeModel<T>
  readonly renderRow: (ctx: ITreeRowRenderContext<T>) => ReactNode
  readonly rowHeight?: number
  readonly virtualizationThreshold?: number
  readonly indentWidth?: number
  readonly indentBase?: number
  readonly className?: string
  readonly ariaLabel?: string
  /** Receives the tree container element (e.g. to register it as focusable). */
  readonly rootRef?: Ref<HTMLDivElement>
  /** Activate a leaf (Enter / Space / plain click on a node without children). */
  readonly onActivate?: (node: IVisibleNode<T>, opts: ITreeActivateOptions) => void
  /**
   * Treat every row as activatable on Enter — including non-leaf rows, which
   * would otherwise toggle. Expand/collapse then lives entirely on Left/Right.
   * Used by Outline, where each symbol is a jump target (Explorer keeps the
   * default: Enter toggles a folder). Space still previews leaves either way.
   */
  readonly activateNonLeafOnEnter?: boolean
  /** Keys not handled by built-in navigation (e.g. F2 / Delete) reach the view here. */
  readonly onRowKeyDown?: (e: ReactKeyboardEvent, node: IVisibleNode<T>) => void
  /** Shift+Tab inside the tree — lets the view hand focus back to a prior region. */
  readonly onShiftTab?: () => void
  /** Context menu on empty area (null) — per-row menus are the view's job in renderRow. */
  readonly onContextMenu?: (e: ReactMouseEvent, node: IVisibleNode<T> | null) => void
  /** Called when the tree container receives DOM focus — before built-in focus state update. */
  readonly onFocus?: () => void
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
}

export function Tree<T>(props: ITreeProps<T>) {
  const {
    model,
    renderRow,
    rowHeight = DEFAULT_ROW_HEIGHT,
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
    activateNonLeafOnEnter = false,
    scrollStateKey,
    scrollStatePersister,
  } = props

  const { selectionVersion, visibleNodes } = useTreeModel(model)
  void selectionVersion // re-render on selection change so row flags stay fresh

  const [hasFocus, setHasFocus] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const virtualRef = useRef<VirtualListHandle>(null)
  const visibleRef = useRef(visibleNodes)
  visibleRef.current = visibleNodes

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

  // Reveal: defer scroll to after commit. Prefer scrollIntoView on the row
  // element (works virtual + non-virtual); fall back to scrollToIndex when the
  // target row is outside the virtualizer's rendered window.
  const [revealRequest, setRevealRequest] = useState<{ id: string; tick: number } | null>(null)
  useEffect(() => {
    // Singleton for the same reason as useTreeModel: a page-reload unmount runs
    // before passive cleanup flushes, which would otherwise leak-report this.
    const d = markAsSingleton(
      model.onReveal(({ id }) => setRevealRequest((prev) => ({ id, tick: (prev?.tick ?? 0) + 1 }))),
    )
    return () => d.dispose()
  }, [model])

  useLayoutEffect(() => {
    if (!revealRequest) return
    const root = containerRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>(`[data-row-key="${revealRequest.id}"]`)
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
      return
    }
    if (virtualRef.current) {
      const idx = visibleRef.current.findIndex((n) => n.id === revealRequest.id)
      if (idx < 0) return
      // "Not in the DOM" does not always mean "off-screen": the virtualizer may
      // not have rendered against the current scroll position yet, which makes
      // every row below the top look unrendered. Scrolling then would yank the
      // clicked row to the top of the viewport. Rows are fixed-height here, so
      // decide from the scroller's geometry and only scroll when genuinely out
      // of view.
      const scroller = virtualRef.current.getScrollElement()
      if (scroller) {
        const top = idx * rowHeight
        const visibleTop = scroller.scrollTop
        const visibleBottom = visibleTop + scroller.clientHeight
        if (top >= visibleTop && top + rowHeight <= visibleBottom) return
      }
      virtualRef.current.scrollToIndex(idx, { align: 'start' })
    }
  }, [revealRequest, rowHeight])

  // Keyboard context menu (ContextMenu key / Shift+F10): the browser's own
  // synthetic contextmenu event carries (0,0) coordinates, which would anchor
  // the menu at a fixed corner. VSCode parity: dispatch a contextmenu on the
  // focused row with coordinates derived from its bounding rect, so each view's
  // existing row handler opens the menu exactly like a mouse right-click.
  const openKeyboardContextMenu = useCallback((node: IVisibleNode<T> | null) => {
    const root = containerRef.current
    if (!root) return
    const row = node
      ? (root.querySelector<HTMLElement>(`[data-row-key="${node.id}"]`) ?? null)
      : null
    const target = row ?? root
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        // detail 1 marks the event as mouse-like so the container's detail-0
        // guard below doesn't mistake it for Chromium's keyup supplement.
        detail: 1,
        clientX: rect.left,
        clientY: row ? rect.bottom : rect.top,
      }),
    )
  }, [])

  const makeClickHandler = useCallback(
    (node: IVisibleNode<T>) => (e: ReactMouseEvent) => {
      if (e.shiftKey) {
        model.selectRange(model.focused ?? node.id, node.id)
        return
      }
      if (e.ctrlKey || e.metaKey) {
        model.toggleInSelection(node.id)
        return
      }
      model.setSelection([node.id], node.id)
      if (node.hasChildren) void model.toggle(node.element)
      else onActivate?.(node, { preview: true })
    },
    [model, onActivate],
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
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
        if (e.shiftKey && model.focused) model.selectRange(model.focused, target.id)
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
          handled()
          moveTo(0)
          return
        case 'End':
          handled()
          moveTo(vis.length - 1)
          return
        case 'PageDown':
          handled()
          moveTo((currentIndex < 0 ? 0 : currentIndex) + PAGE_STEP)
          return
        case 'PageUp':
          handled()
          moveTo((currentIndex < 0 ? 0 : currentIndex) - PAGE_STEP)
          return
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
          else onActivate?.(current, { preview: false })
          return
        case ' ':
          if (!current) return
          handled()
          if (current.hasChildren) void model.toggle(current.element)
          else onActivate?.(current, { preview: true })
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
    [model, onActivate, onRowKeyDown, onShiftTab, activateNonLeafOnEnter, openKeyboardContextMenu],
  )

  const renderNode = (node: IVisibleNode<T>, style?: CSSProperties): ReactNode =>
    renderRow({
      node,
      isSelected: model.isSelected(node.id),
      isFocused: model.focused === node.id,
      indentPadding: node.depth * indentWidth + indentBase,
      onToggle: () => void model.toggle(node.element),
      onClickRow: makeClickHandler(node),
      style,
    })

  return (
    <div
      ref={setContainer}
      className={className}
      role="tree"
      aria-label={ariaLabel}
      tabIndex={0}
      data-focused={hasFocus}
      onKeyDown={onKeyDown}
      onMouseDown={() => containerRef.current?.focus({ preventScroll: true })}
      onFocus={() => {
        setHasFocus(true)
        onFocus?.()
      }}
      onBlur={() => setHasFocus(false)}
      {...(onContextMenu
        ? {
            onContextMenu: (e: ReactMouseEvent) => {
              // Chromium re-dispatches the contextmenu on keyup for the
              // ContextMenu key / Shift+F10 (keydown preventDefault can't cancel
              // it): detail 0, target = the focused container, (0,0) coords.
              // Swallow it — the keyboard handler already opened the menu.
              if (e.detail === 0) {
                e.preventDefault()
                return
              }
              onContextMenu(e, null)
            },
          }
        : {})}
    >
      {containerReady && (
        <VirtualList
          ref={virtualRef}
          items={visibleNodes}
          estimateSize={() => rowHeight}
          scrollElementRef={containerRef}
          windowed={visibleNodes.length > virtualizationThreshold}
          renderItem={(node, style) => renderNode(node, style)}
        />
      )}
    </div>
  )
}
