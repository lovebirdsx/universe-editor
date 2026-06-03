import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useDeferredValue,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { IQuickInputService, markAsSingleton } from '@universe-editor/platform'
import type {
  IKeyMods,
  IQuickItemHighlight,
  IQuickPickItem,
  IQuickPickSeparator,
  QuickPickFilterMode,
  QuickPickInput,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { FocusScopeOverlay } from '../common/FocusScopeOverlay.js'
import { resolveAgentIcon } from '../agents/agentIcon.js'
import {
  QuickInputService,
  type QuickPickState,
} from '../../services/quickInput/QuickInputService.js'
import { fuzzyMatchField, wordMatchField } from '../../services/fuzzyMatch/fuzzyMatch.js'
import styles from './QuickInput.module.css'

function itemMatches(
  item: IQuickPickItem,
  query: string,
  mode: QuickPickFilterMode,
  matchOnDescription: boolean,
  matchOnDetail: boolean,
): boolean {
  const matcher = mode === 'word' ? wordMatchField : fuzzyMatchField
  if (matcher(item.label, query)) return true
  if (matchOnDescription && item.description && matcher(item.description, query)) {
    return true
  }
  if (matchOnDetail && item.detail && matcher(item.detail, query)) return true
  return false
}

function isSeparator(item: QuickPickInput<IQuickPickItem>): item is IQuickPickSeparator {
  return 'type' in item && item.type === 'separator'
}

function isSelectable(item: QuickPickInput<IQuickPickItem> | undefined): item is IQuickPickItem {
  return item !== undefined && !isSeparator(item)
}

function compareMru(a: IQuickPickItem, b: IQuickPickItem, mruIds: readonly string[]): number {
  const ai = mruIds.indexOf(a.id)
  const bi = mruIds.indexOf(b.id)
  if (ai === -1 && bi === -1) return 0
  if (ai === -1) return 1
  if (bi === -1) return -1
  return ai - bi
}

function firstSelectableIndex(items: readonly QuickPickInput<IQuickPickItem>[]): number {
  const idx = items.findIndex((item) => !isSeparator(item))
  return idx === -1 ? 0 : idx
}

function normalizeSelectableIndex(
  items: readonly QuickPickInput<IQuickPickItem>[],
  index: number,
): number {
  if (isSelectable(items[index])) return index
  return firstSelectableIndex(items)
}

function nextSelectableIndex(
  items: readonly QuickPickInput<IQuickPickItem>[],
  current: number,
  direction: 1 | -1,
): number {
  if (items.length === 0) return 0
  let next = current
  for (let i = 0; i < items.length; i++) {
    next = (next + direction + items.length) % items.length
    if (isSelectable(items[next])) return next
  }
  return normalizeSelectableIndex(items, current)
}

function pagedSelectableIndex(
  items: readonly QuickPickInput<IQuickPickItem>[],
  current: number,
  direction: 1 | -1,
  pageSize: number,
): number {
  const selectable = items
    .map((item, index) => (isSeparator(item) ? -1 : index))
    .filter((index) => index >= 0)
  if (selectable.length === 0) return 0
  const normalized = normalizeSelectableIndex(items, current)
  const selectableOffset = Math.max(0, selectable.indexOf(normalized))
  const nextOffset =
    direction > 0
      ? Math.min(selectableOffset + pageSize, selectable.length - 1)
      : Math.max(selectableOffset - pageSize, 0)
  return selectable[nextOffset] ?? normalized
}

function filterWithSeparators(
  items: readonly QuickPickInput<IQuickPickItem>[],
  query: string,
  mode: QuickPickFilterMode,
  matchOnDescription: boolean,
  matchOnDetail: boolean,
): QuickPickInput<IQuickPickItem>[] {
  const result: QuickPickInput<IQuickPickItem>[] = []
  let pendingSeparator: IQuickPickSeparator | undefined

  for (const item of items) {
    if (isSeparator(item)) {
      pendingSeparator = item
      continue
    }
    if (!itemMatches(item, query, mode, matchOnDescription, matchOnDetail)) continue
    if (pendingSeparator) {
      result.push(pendingSeparator)
      pendingSeparator = undefined
    }
    result.push(item)
  }

  return result
}

function renderHighlightedText(
  text: string,
  highlights: readonly IQuickItemHighlight[] | undefined,
) {
  if (!highlights || highlights.length === 0) return text

  const normalized = highlights
    .map((highlight) => ({
      start: Math.max(0, Math.min(text.length, highlight.start)),
      end: Math.max(0, Math.min(text.length, highlight.end)),
    }))
    .filter((highlight) => highlight.start < highlight.end)
    .sort((a, b) => a.start - b.start)

  if (normalized.length === 0) return text

  const parts: ReactNode[] = []
  let cursor = 0
  for (let i = 0; i < normalized.length; i++) {
    const highlight = normalized[i]!
    if (highlight.start < cursor) continue
    if (highlight.start > cursor) {
      parts.push(text.slice(cursor, highlight.start))
    }
    parts.push(
      <mark key={`h-${i}`} className={styles['highlight']}>
        {text.slice(highlight.start, highlight.end)}
      </mark>,
    )
    cursor = highlight.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function isCtrlNavigationKey(e: KeyboardEvent<HTMLInputElement>, key: 'n' | 'p'): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === key
}

// Exported for unit tests so prefix / filtering behavior can be exercised
// without booting the full portal + service plumbing.
export function QuickPickPanel({ state, onClose }: { state: QuickPickState; onClose: () => void }) {
  const prefix = state.prefix ?? ''
  const [query, setQuery] = useState(state.value ?? prefix)
  const quickNavigate = state.quickNavigate
  const [focusedIdx, setFocusedIdx] = useState(quickNavigate?.initialSelectionIndex ?? 0)
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mruIds = state.mruIds ?? []
  const filterMode = state.filterMode ?? 'fuzzy'
  const matchOnDescription = state.matchOnDescription === true
  const matchOnDetail = state.matchOnDetail === true
  const onItemRemove = state.onItemRemove
  const filterExternally = state.filterExternally === true
  const compact = state.presentation === 'compact'

  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  const prefixActive = prefix.length > 0 && query.startsWith(prefix)
  const prefixMissing = prefix.length > 0 && !query.startsWith(prefix)
  const filterText = prefixActive ? query.slice(prefix.length) : prefix.length > 0 ? '' : query

  const deferredFilterText = useDeferredValue(filterText)

  const filtered = useMemo(() => {
    if (prefixMissing) return []
    const items = (state.items ?? []).filter((item) => !removedIds.has(item.id))
    if (filterExternally) return items
    return filterWithSeparators(
      items,
      deferredFilterText,
      filterMode,
      matchOnDescription,
      matchOnDetail,
    )
  }, [
    prefixMissing,
    filterExternally,
    state.items,
    removedIds,
    deferredFilterText,
    filterMode,
    matchOnDescription,
    matchOnDetail,
  ])

  const sortedFiltered = useMemo(
    () => {
      if (filterExternally || filtered.some(isSeparator)) return filtered
      return [...filtered].sort((a, b) => {
        if (isSeparator(a) || isSeparator(b)) return 0
        const mruCompare = compareMru(a, b, mruIds)
        if (mruCompare !== 0) return mruCompare
        if (filterMode === 'word') return a.label.localeCompare(b.label)
        return 0
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, filterExternally, filterMode, mruIds.join(',')],
  )

  const ITEM_HEIGHT = compact ? 24 : 32
  const SEPARATOR_HEIGHT = compact ? 26 : 30
  const estimateItemSize = (index: number): number => {
    const item = sortedFiltered[index]
    return item && isSeparator(item) ? SEPARATOR_HEIGHT : ITEM_HEIGHT
  }

  const virtualizer = useVirtualizer({
    count: sortedFiltered.length,
    getScrollElement: () => listRef.current,
    estimateSize: estimateItemSize,
    overscan: 5,
  })

  useEffect(() => {
    if (quickNavigate) {
      setFocusedIdx((idx) => normalizeSelectableIndex(sortedFiltered, idx))
      return
    }
    setFocusedIdx(firstSelectableIndex(sortedFiltered))
  }, [query, quickNavigate, sortedFiltered])

  useEffect(() => {
    if (sortedFiltered.length > 0) {
      if (!isSelectable(sortedFiltered[focusedIdx])) {
        if (listRef.current) listRef.current.scrollTop = 0
        return
      }
      if (focusedIdx === firstSelectableIndex(sortedFiltered)) {
        if (listRef.current) listRef.current.scrollTop = 0
        return
      }
      virtualizer.scrollToIndex(focusedIdx, { align: 'auto' })
    }
  }, [focusedIdx, sortedFiltered, sortedFiltered.length, virtualizer])

  const accept = useCallback(
    (items: IQuickPickItem[], mods?: IKeyMods) => {
      state.onAccept?.(items, mods)
      onClose()
    },
    [state, onClose],
  )

  const removeItem = useCallback(
    (item: IQuickPickItem) => {
      if (!onItemRemove) return
      onItemRemove(item)
      setRemovedIds((prev) => {
        const next = new Set(prev)
        next.add(item.id)
        return next
      })
    },
    [onItemRemove],
  )

  // Quick navigate mode: release of the modifier accepts the focused item.
  // Refs let the document keyup listener read the latest state without
  // re-binding on every focusedIdx change.
  const sortedFilteredRef = useRef(sortedFiltered)
  sortedFilteredRef.current = sortedFiltered
  const focusedIdxRef = useRef(focusedIdx)
  focusedIdxRef.current = focusedIdx
  const acceptRef = useRef(accept)
  acceptRef.current = accept

  useEffect(() => {
    if (!quickNavigate) return
    const modifierKey = quickNavigate.modifier === 'ctrl' ? 'Control' : ''
    if (!modifierKey) return
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.key !== modifierKey) return
      const list = sortedFilteredRef.current
      const item = list[focusedIdxRef.current]
      if (isSelectable(item)) acceptRef.current([item])
    }
    document.addEventListener('keyup', onKeyUp, true)
    return () => document.removeEventListener('keyup', onKeyUp, true)
  }, [quickNavigate])

  const PAGE_SIZE = 8

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const len = sortedFiltered.length
    if (quickNavigate && e.key === 'Tab') {
      e.preventDefault()
      if (len === 0) return
      if (e.shiftKey) setFocusedIdx((i) => nextSelectableIndex(sortedFiltered, i, -1))
      else setFocusedIdx((i) => nextSelectableIndex(sortedFiltered, i, 1))
      return
    }
    if (e.key === 'ArrowDown' || isCtrlNavigationKey(e, 'n')) {
      e.preventDefault()
      setFocusedIdx((i) => nextSelectableIndex(sortedFiltered, i, 1))
    } else if (e.key === 'ArrowUp' || isCtrlNavigationKey(e, 'p')) {
      e.preventDefault()
      setFocusedIdx((i) => nextSelectableIndex(sortedFiltered, i, -1))
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setFocusedIdx((i) => pagedSelectableIndex(sortedFiltered, i, 1, PAGE_SIZE))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      setFocusedIdx((i) => pagedSelectableIndex(sortedFiltered, i, -1, PAGE_SIZE))
    } else if (e.key === 'Delete' && onItemRemove) {
      e.preventDefault()
      const item = sortedFiltered[focusedIdx]
      if (isSelectable(item)) removeItem(item)
    } else if (e.key === 'Enter') {
      // preventDefault stops the native keydown from leaking to whichever element
      // receives focus after the panel closes (typically the Monaco editor), which
      // would otherwise cause an unwanted newline insertion.
      e.preventDefault()
      const item = sortedFiltered[focusedIdx]
      if (isSelectable(item)) accept([item], { ctrl: e.ctrlKey, alt: e.altKey })
    }
  }

  return (
    <div className={styles['container']} role="dialog" aria-modal data-testid="quick-input">
      <div className={styles['inputRow']}>
        <input
          ref={inputRef}
          className={styles['input']}
          value={query}
          onChange={(e) => {
            const value = e.target.value
            setQuery(value)
            state.onValueChange?.(value)
          }}
          onKeyDown={handleKey}
          placeholder={state.placeholder ?? 'Type to filter…'}
          aria-label={state.placeholder ?? 'Quick pick input'}
          data-testid="quick-input-field"
        />
      </div>
      {state.busy === true && (
        <div className={styles['progress']} data-testid="quick-input-busy">
          <div className={styles['progressBar']} />
        </div>
      )}
      <div className={styles['list']} role="listbox" ref={listRef}>
        {prefixMissing ? (
          <p className={styles['empty']}>Type {`'${prefix}'`} followed by a command name</p>
        ) : sortedFiltered.length === 0 ? (
          <p className={styles['empty']}>No results</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = sortedFiltered[virtualRow.index]!
              const idx = virtualRow.index
              const focused = idx === focusedIdx && isSelectable(item)
              return (
                <div
                  key={item.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {isSeparator(item) ? (
                    <div
                      className={`${styles['separator']} ${compact ? styles['compactSeparator'] : ''}`}
                      role="presentation"
                      data-testid="quick-input-separator"
                    >
                      {item.label && <span className={styles['separatorLabel']}>{item.label}</span>}
                      {item.description && (
                        <span className={styles['separatorDesc']}>{item.description}</span>
                      )}
                    </div>
                  ) : (
                    <button
                      className={`${styles['item']} ${compact ? styles['compactItem'] : ''} ${
                        focused ? styles['focused'] : ''
                      }`}
                      role="option"
                      aria-selected={focused}
                      onClick={(e) => accept([item], { ctrl: e.ctrlKey, alt: e.altKey })}
                      onMouseMove={() => setFocusedIdx(idx)}
                    >
                      {!query && mruIds.includes(item.id) && <span className={styles['mruDot']} />}
                      {item.iconId &&
                        (() => {
                          const Icon = resolveAgentIcon(item.iconId)
                          return <Icon size={14} className={styles['itemIcon']} />
                        })()}
                      <span className={styles['itemLabel']}>
                        {renderHighlightedText(item.label, item.highlights?.label)}
                      </span>
                      {item.description && (
                        <span className={styles['itemDesc']}>
                          {renderHighlightedText(item.description, item.highlights?.description)}
                        </span>
                      )}
                      {item.keybinding && (
                        <span className={styles['itemKeybinding']}>{item.keybinding}</span>
                      )}
                      {onItemRemove && (
                        <span
                          role="button"
                          aria-label="Remove from list"
                          className={styles['itemRemove']}
                          data-testid="quick-input-item-remove"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeItem(item)
                          }}
                        >
                          x
                        </span>
                      )}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function InputPanel({ state, onClose }: { state: QuickPickState; onClose: () => void }) {
  const [value, setValue] = useState(state.inputValue ?? '')
  const [error, setError] = useState<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const err = state.validateInput?.(value)
      if (err) {
        setError(err)
        return
      }
      state.onInput?.(value)
      onClose()
    } else if (isCtrlNavigationKey(e, 'n') || isCtrlNavigationKey(e, 'p')) {
      e.preventDefault()
    }
  }

  return (
    <div className={styles['container']} role="dialog" aria-modal data-testid="quick-input">
      {state.inputPrompt && <p className={styles['prompt']}>{state.inputPrompt}</p>}
      <div className={styles['inputRow']}>
        <input
          ref={inputRef}
          className={styles['input']}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(undefined)
          }}
          onKeyDown={handleKey}
          placeholder={state.placeholder}
          aria-label={state.placeholder ?? 'Input'}
          aria-invalid={!!error}
        />
      </div>
      {state.busy === true && (
        <div className={styles['progress']} data-testid="quick-input-busy">
          <div className={styles['progressBar']} />
        </div>
      )}
      {error && (
        <p className={styles['empty']} style={{ color: '#f14c4c' }}>
          {error}
        </p>
      )}
    </div>
  )
}

/** Portal that renders Quick Pick / Input Box over the entire workbench. */
export function QuickInputPortal() {
  const quickInputService = useService(IQuickInputService)
  const svc = quickInputService as QuickInputService
  const [panelState, setPanelState] = useState<QuickPickState | null>(svc.currentState)

  useEffect(() => {
    const d = markAsSingleton(svc.onDidChangeState((s) => setPanelState(s)))
    setPanelState(svc.currentState)
    return () => d.dispose()
  }, [svc])

  if (!panelState) return null

  const close = () => svc.hide()

  return createPortal(
    <FocusScopeOverlay visible onEscape={close}>
      <div className={styles['overlay']} onClick={close} data-testid="quick-input-overlay">
        <div onClick={(e) => e.stopPropagation()}>
          {panelState.type === 'pick' ? (
            <QuickPickPanel state={panelState} onClose={close} />
          ) : (
            <InputPanel state={panelState} onClose={close} />
          )}
        </div>
      </div>
    </FocusScopeOverlay>,
    document.body,
  )
}
