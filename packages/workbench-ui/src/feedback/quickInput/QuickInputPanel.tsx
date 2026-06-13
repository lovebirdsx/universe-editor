/*---------------------------------------------------------------------------------------------
 *  QuickInputPanel — presentational Quick Pick / Input Box body. Pure: renders a
 *  QuickPickState plus an onClose callback. Icon resolution is injected via
 *  renderIcon/renderStatusIcon so the library stays free of the host's icon sets.
 *  Filtering, navigation, virtualization and quick-navigate all live here; the
 *  host wrapper owns the service subscription, focus trap and Portal.
 *--------------------------------------------------------------------------------------------*/

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
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  IKeyMods,
  IQuickItemHighlight,
  IQuickPickItem,
  IQuickPickItemHighlights,
  IQuickPickSeparator,
  QuickPickInput,
} from '@universe-editor/platform'
import { fuzzyScore, wordMatchField } from '../../text/fuzzyMatch.js'
import type { QuickPickState } from './quickInputViewModel.js'
import styles from './QuickInput.module.css'

/** Resolve an icon id to an element. Returns null to render nothing. */
export type RenderQuickIcon = (
  iconId: string,
  size: number,
  className?: string | undefined,
) => ReactNode

export interface QuickInputPanelProps {
  state: QuickPickState
  onClose: () => void
  renderIcon?: RenderQuickIcon | undefined
  renderStatusIcon?: RenderQuickIcon | undefined
}

function wordItemMatches(
  item: IQuickPickItem,
  query: string,
  matchOnDescription: boolean,
  matchOnDetail: boolean,
): boolean {
  if (wordMatchField(item.label, query)) return true
  if (item.leadingLabel && wordMatchField(item.leadingLabel, query)) return true
  if (matchOnDescription && item.description && wordMatchField(item.description, query)) {
    return true
  }
  if (matchOnDetail && item.detail && wordMatchField(item.detail, query)) return true
  return false
}

/**
 * Fuzzy-match an item across its fields, returning a ranking score plus the
 * highlight ranges to render. `null` means no field matched. The label (and the
 * fixed leading column, folded into it) ranks highest; description/detail are
 * demoted so a name hit always outranks a path/detail hit. The matched ranges
 * are returned as highlights so ranking and highlighting can never disagree.
 */
function fuzzyItemMatch(
  item: IQuickPickItem,
  query: string,
  matchOnDescription: boolean,
  matchOnDetail: boolean,
): { score: number; highlights: IQuickPickItemHighlights | undefined } | null {
  const labelRes = fuzzyScore(item.label, query)
  const leadingRes = item.leadingLabel ? fuzzyScore(item.leadingLabel, query) : null
  const descRes =
    matchOnDescription && item.description ? fuzzyScore(item.description, query) : null
  const detailRes = matchOnDetail && item.detail ? fuzzyScore(item.detail, query) : null

  const scores: number[] = []
  if (labelRes) scores.push(labelRes.score)
  if (leadingRes) scores.push(leadingRes.score)
  if (descRes) scores.push(descRes.score - 1000)
  if (detailRes) scores.push(detailRes.score - 1000)
  if (scores.length === 0) return null

  const highlights: { -readonly [K in keyof IQuickPickItemHighlights]: IQuickItemHighlight[] } = {}
  if (labelRes && labelRes.matches.length > 0) highlights.label = [...labelRes.matches]
  if (descRes && descRes.matches.length > 0) highlights.description = [...descRes.matches]

  return {
    score: Math.max(...scores),
    highlights: highlights.label || highlights.description ? highlights : undefined,
  }
}

function isSeparator(item: QuickPickInput<IQuickPickItem>): item is IQuickPickSeparator {
  return 'type' in item && item.type === 'separator'
}

/**
 * Fuzzy filter + relevance sort that respects separator grouping: each section
 * (the leading section and every separator-led one) is filtered and sorted by
 * score independently, empty sections drop out, and matched ranges are attached
 * as highlights. An empty query keeps the original order (all scores tie and the
 * sort is stable), preserving e.g. document order for the symbol picker.
 */
function fuzzyFilterAndSort(
  items: readonly QuickPickInput<IQuickPickItem>[],
  query: string,
  matchOnDescription: boolean,
  matchOnDetail: boolean,
  mruIds: readonly string[],
): QuickPickInput<IQuickPickItem>[] {
  const result: QuickPickInput<IQuickPickItem>[] = []
  let pendingSeparator: IQuickPickSeparator | undefined
  let section: { item: IQuickPickItem; score: number }[] = []

  const flushSection = (): void => {
    if (section.length === 0) return
    // Score-descending; ties (notably an empty query, where all score 0) fall
    // back to MRU so a "recently used" head is preserved.
    section.sort((a, b) => b.score - a.score || compareMru(a.item, b.item, mruIds))
    if (pendingSeparator) result.push(pendingSeparator)
    for (const { item } of section) result.push(item)
    pendingSeparator = undefined
    section = []
  }

  for (const item of items) {
    if (isSeparator(item)) {
      flushSection()
      pendingSeparator = item
      continue
    }
    const match = fuzzyItemMatch(item, query, matchOnDescription, matchOnDetail)
    if (!match) continue
    const withHighlights = match.highlights ? { ...item, highlights: match.highlights } : item
    section.push({ item: withHighlights, score: match.score })
  }
  flushSection()

  return result
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
    if (!wordItemMatches(item, query, matchOnDescription, matchOnDetail)) continue
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
export function QuickPickPanel({
  state,
  onClose,
  renderIcon,
  renderStatusIcon,
}: QuickInputPanelProps) {
  const prefix = state.prefix ?? ''
  const [query, setQuery] = useState(state.value ?? prefix)
  const quickNavigate = state.quickNavigate
  const [focusedIdx, setFocusedIdx] = useState(quickNavigate?.initialSelectionIndex ?? 0)
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mruIds = state.mruIds ?? []
  const mruKey = mruIds.join(',')
  const filterMode = state.filterMode ?? 'fuzzy'
  const matchOnDescription = state.matchOnDescription === true
  const matchOnDetail = state.matchOnDetail === true
  const onItemRemove = state.onItemRemove
  const filterExternally = state.filterExternally === true
  const compact = state.presentation === 'compact'
  const hasIconColumn = useMemo(
    () => (state.items ?? []).some((item) => !isSeparator(item) && item.iconId !== undefined),
    [state.items],
  )

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
    if (filterMode === 'word') {
      return filterWithSeparators(items, deferredFilterText, matchOnDescription, matchOnDetail)
    }
    return fuzzyFilterAndSort(items, deferredFilterText, matchOnDescription, matchOnDetail, mruIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    prefixMissing,
    filterExternally,
    state.items,
    removedIds,
    deferredFilterText,
    filterMode,
    matchOnDescription,
    matchOnDetail,
    mruKey,
  ])

  const sortedFiltered = useMemo(
    () => {
      // Fuzzy mode is already relevance-sorted (with separator grouping) by
      // fuzzyFilterAndSort. External filtering and word mode keep provider order,
      // applying only MRU and, for word mode, an alphabetical tiebreak.
      if (filterExternally || filterMode === 'fuzzy' || filtered.some(isSeparator)) return filtered
      return [...filtered].sort((a, b) => {
        if (isSeparator(a) || isSeparator(b)) return 0
        const mruCompare = compareMru(a, b, mruIds)
        if (mruCompare !== 0) return mruCompare
        return a.label.localeCompare(b.label)
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, filterExternally, filterMode, mruKey],
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

  // Report the active (focused) item to the host for live preview. Deduped by id
  // so re-renders that keep the same focused item (e.g. typing, virtual scroll)
  // don't re-fire. No-op unless the host wired onActiveChange.
  const onActiveChange = state.onActiveChange
  const lastActiveIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!onActiveChange) return
    const active = sortedFiltered[focusedIdx]
    const item = isSelectable(active) ? active : undefined
    if (item?.id === lastActiveIdRef.current) return
    lastActiveIdRef.current = item?.id
    onActiveChange(item)
  }, [onActiveChange, sortedFiltered, focusedIdx])

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
    } else if (quickNavigate && onItemRemove && e.key.toLowerCase() === 'x') {
      // In quick-navigate mode (e.g. Ctrl+Tab editor switcher) the input box is
      // not used for typing, so `x` can act as a remove shortcut. Scoped to
      // quickNavigate so ordinary quick picks keep `x` as a search character.
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
          spellCheck={false}
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
                      {hasIconColumn && (
                        <span
                          className={styles['itemIconSlot']}
                          data-testid="quick-input-item-icon-slot"
                          data-icon-id={item.iconId ?? ''}
                          aria-hidden="true"
                        >
                          {item.iconId ? renderIcon?.(item.iconId, 14, styles['itemIcon']) : null}
                        </span>
                      )}
                      {item.leadingLabel && (
                        <span className={styles['itemLeading']}>{item.leadingLabel}</span>
                      )}
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
                      {item.statusIconId
                        ? renderStatusIcon?.(item.statusIconId, 14, styles['itemStatusIcon'])
                        : null}
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
          spellCheck={false}
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

/** Renders the Quick Pick or Input Box body depending on `state.type`. */
export function QuickInputPanel({
  state,
  onClose,
  renderIcon,
  renderStatusIcon,
}: QuickInputPanelProps) {
  return state.type === 'pick' ? (
    <QuickPickPanel
      state={state}
      onClose={onClose}
      renderIcon={renderIcon}
      renderStatusIcon={renderStatusIcon}
    />
  ) : (
    <InputPanel state={state} onClose={onClose} />
  )
}
