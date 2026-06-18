/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tree — generic render-prop tree view.
 *
 *  Owns the structural concerns shared by every tree (Explorer / Scm / Search):
 *  the role="tree" focusable container, keyboard navigation, virtualization
 *  threshold switching and reveal-into-view scrolling. Row content — twistie,
 *  icon, label, inline actions, highlights — is entirely the view's job via
 *  `renderRow`. The view also owns per-row context menu / drag-and-drop.
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
  /** Class for the inner VirtualList scroller (virtual mode only) — usually `flex:1; min-height:0`. */
  readonly virtualListClassName?: string
  readonly ariaLabel?: string
  /** Receives the tree container element (e.g. to register it as focusable). */
  readonly rootRef?: Ref<HTMLDivElement>
  /** Activate a leaf (Enter / Space / plain click on a node without children). */
  readonly onActivate?: (node: IVisibleNode<T>, opts: ITreeActivateOptions) => void
  /** Keys not handled by built-in navigation (e.g. F2 / Delete) reach the view here. */
  readonly onRowKeyDown?: (e: ReactKeyboardEvent, node: IVisibleNode<T>) => void
  /** Shift+Tab inside the tree — lets the view hand focus back to a prior region. */
  readonly onShiftTab?: () => void
  /** Context menu on empty area (null) — per-row menus are the view's job in renderRow. */
  readonly onContextMenu?: (e: ReactMouseEvent, node: IVisibleNode<T> | null) => void
  /** Called when the tree container receives DOM focus — before built-in focus state update. */
  readonly onFocus?: () => void
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
    virtualListClassName,
    ariaLabel,
    rootRef,
    onActivate,
    onRowKeyDown,
    onShiftTab,
    onContextMenu,
    onFocus,
  } = props

  const { selectionVersion, visibleNodes } = useTreeModel(model)
  void selectionVersion // re-render on selection change so row flags stay fresh

  const [hasFocus, setHasFocus] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const virtualRef = useRef<VirtualListHandle>(null)
  const visibleRef = useRef(visibleNodes)
  visibleRef.current = visibleNodes

  const setContainer = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el
      if (typeof rootRef === 'function') rootRef(el)
      else if (rootRef) (rootRef as { current: HTMLDivElement | null }).current = el
    },
    [rootRef],
  )

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
      if (idx >= 0) virtualRef.current.scrollToIndex(idx, { align: 'start' })
    }
  }, [revealRequest])

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
          moveTo(currentIndex < 0 ? 0 : currentIndex + 1)
          return
        case 'ArrowUp':
          handled()
          moveTo(currentIndex < 0 ? 0 : currentIndex - 1)
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
          if (current.hasChildren) {
            if (current.expanded) {
              const next = vis[currentIndex + 1]
              if (next) model.setSelection([next.id], next.id)
            } else {
              void model.expand(current.element)
            }
          }
          return
        case 'ArrowLeft':
          if (!current) return
          handled()
          if (current.hasChildren && current.expanded) {
            model.collapse(current.element)
          } else {
            const parent = model.getParentNode(current.id)
            if (parent) model.setSelection([parent.id], parent.id)
          }
          return
        case 'Enter':
          if (!current) return
          handled()
          if (current.hasChildren) void model.toggle(current.element)
          else onActivate?.(current, { preview: false })
          return
        case ' ':
          if (!current) return
          handled()
          if (current.hasChildren) void model.toggle(current.element)
          else onActivate?.(current, { preview: true })
          return
        default:
          if (current) onRowKeyDown?.(e, current)
          return
      }
    },
    [model, onActivate, onRowKeyDown, onShiftTab],
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
      {...(onContextMenu ? { onContextMenu: (e: ReactMouseEvent) => onContextMenu(e, null) } : {})}
    >
      {visibleNodes.length > virtualizationThreshold ? (
        <VirtualList
          ref={virtualRef}
          items={visibleNodes}
          estimateSize={() => rowHeight}
          {...(virtualListClassName !== undefined ? { className: virtualListClassName } : {})}
          renderItem={(node, style) => renderNode(node, style)}
        />
      ) : (
        <>{visibleNodes.map((node) => renderNode(node))}</>
      )}
    </div>
  )
}
