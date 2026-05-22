import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useDeferredValue,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { IQuickInputService } from '@universe-editor/platform'
import type { IQuickPickItem, QuickPickFilterMode } from '@universe-editor/platform'
import { useService } from '../useService.js'
import {
  QuickInputService,
  type QuickPickState,
} from '../../services/quickInput/QuickInputService.js'
import styles from './QuickInput.module.css'

function fuzzyMatchField(text: string, query: string): boolean {
  if (!query) return true
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++
  }
  return qi === q.length
}

function normalizeWordQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

function isAsciiLetterOrDigit(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isWordSeparator(ch: string): boolean {
  return !isAsciiLetterOrDigit(ch)
}

function getWordStarts(text: string): number[] {
  const starts: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === undefined || isWordSeparator(ch)) continue
    const prev = i > 0 ? text[i - 1] : undefined
    if (prev === undefined || isWordSeparator(prev)) starts.push(i)
  }
  return starts
}

function findWordPrefix(text: string, piece: string, from: number): number {
  for (const start of getWordStarts(text)) {
    if (start < from) continue
    if (text.startsWith(piece, start)) return start
  }
  return -1
}

function wordPiecesMatch(text: string, pieces: readonly string[]): boolean {
  let from = 0
  for (const piece of pieces) {
    const start = findWordPrefix(text, piece, from)
    if (start === -1) return false
    from = start + piece.length
  }
  return true
}

function compactWordStartsMatch(text: string, query: string): boolean {
  const starts = getWordStarts(text)

  const visit = (startIndex: number, queryIndex: number): boolean => {
    if (queryIndex >= query.length) return true

    for (let i = startIndex; i < starts.length; i++) {
      const start = starts[i]!
      let consumed = 0
      while (queryIndex + consumed < query.length && start + consumed < text.length) {
        const queryChar = query[queryIndex + consumed]
        const textChar = text[start + consumed]
        if (queryChar === undefined || textChar === undefined || queryChar !== textChar) break
        consumed++
      }

      for (let count = consumed; count > 0; count--) {
        if (visit(i + 1, queryIndex + count)) return true
      }
    }

    return false
  }

  return visit(0, 0)
}

function wordMatchField(text: string, query: string): boolean {
  const normalizedQuery = normalizeWordQuery(query)
  if (!normalizedQuery) return true

  const normalizedText = text.toLowerCase()
  if (normalizedText.includes(normalizedQuery)) return true

  const pieces = normalizedQuery.split(' ').filter((piece) => piece.length > 0)
  if (pieces.length > 1) return wordPiecesMatch(normalizedText, pieces)

  const firstPiece = pieces[0]
  return firstPiece !== undefined && compactWordStartsMatch(normalizedText, firstPiece)
}

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

function compareMru(a: IQuickPickItem, b: IQuickPickItem, mruIds: readonly string[]): number {
  const ai = mruIds.indexOf(a.id)
  const bi = mruIds.indexOf(b.id)
  if (ai === -1 && bi === -1) return 0
  if (ai === -1) return 1
  if (bi === -1) return -1
  return ai - bi
}

function isCtrlNavigationKey(e: KeyboardEvent<HTMLInputElement>, key: 'n' | 'p'): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === key
}

// Exported for unit tests so prefix / filtering behavior can be exercised
// without booting the full portal + service plumbing.
export function QuickPickPanel({ state, onClose }: { state: QuickPickState; onClose: () => void }) {
  const prefix = state.prefix ?? ''
  const [query, setQuery] = useState(prefix)
  const quickNavigate = state.quickNavigate
  const [focusedIdx, setFocusedIdx] = useState(quickNavigate?.initialSelectionIndex ?? 0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mruIds = state.mruIds ?? []
  const filterMode = state.filterMode ?? 'fuzzy'
  const matchOnDescription = state.matchOnDescription === true
  const matchOnDetail = state.matchOnDetail === true

  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  const prefixActive = prefix.length > 0 && query.startsWith(prefix)
  const prefixMissing = prefix.length > 0 && !query.startsWith(prefix)
  const filterText = prefixActive ? query.slice(prefix.length) : prefix.length > 0 ? '' : query

  const deferredFilterText = useDeferredValue(filterText)

  const filtered = useMemo(
    () =>
      prefixMissing
        ? []
        : (state.items ?? []).filter((item) =>
            itemMatches(item, deferredFilterText, filterMode, matchOnDescription, matchOnDetail),
          ),
    [prefixMissing, state.items, deferredFilterText, filterMode, matchOnDescription, matchOnDetail],
  )

  const sortedFiltered = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        const mruCompare = compareMru(a, b, mruIds)
        if (mruCompare !== 0) return mruCompare
        if (filterMode === 'word') return a.label.localeCompare(b.label)
        return 0
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, filterMode, mruIds.join(',')],
  )

  const ITEM_HEIGHT = 32

  const virtualizer = useVirtualizer({
    count: sortedFiltered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 5,
  })

  useEffect(() => {
    if (quickNavigate) return
    setFocusedIdx(0)
  }, [query, quickNavigate])

  useEffect(() => {
    if (sortedFiltered.length > 0) {
      virtualizer.scrollToIndex(focusedIdx, { align: 'auto' })
    }
  }, [focusedIdx, sortedFiltered.length, virtualizer])

  const accept = useCallback(
    (items: IQuickPickItem[]) => {
      state.onAccept?.(items)
      onClose()
    },
    [state, onClose],
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
      if (item) acceptRef.current([item])
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
      if (e.shiftKey) setFocusedIdx((i) => (i - 1 + len) % len)
      else setFocusedIdx((i) => (i + 1) % len)
      return
    }
    if (e.key === 'ArrowDown' || isCtrlNavigationKey(e, 'n')) {
      e.preventDefault()
      setFocusedIdx((i) => (len === 0 ? 0 : (i + 1) % len))
    } else if (e.key === 'ArrowUp' || isCtrlNavigationKey(e, 'p')) {
      e.preventDefault()
      setFocusedIdx((i) => (len === 0 ? 0 : (i - 1 + len) % len))
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setFocusedIdx((i) => (len === 0 ? 0 : Math.min(i + PAGE_SIZE, len - 1)))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      setFocusedIdx((i) => (len === 0 ? 0 : Math.max(i - PAGE_SIZE, 0)))
    } else if (e.key === 'Enter') {
      // preventDefault stops the native keydown from leaking to whichever element
      // receives focus after the panel closes (typically the Monaco editor), which
      // would otherwise cause an unwanted newline insertion.
      e.preventDefault()
      const item = sortedFiltered[focusedIdx]
      if (item) accept([item])
    }
  }

  return (
    <div className={styles['container']} role="dialog" aria-modal data-testid="quick-input">
      <div className={styles['inputRow']}>
        <input
          ref={inputRef}
          className={styles['input']}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
                  <button
                    className={`${styles['item']} ${idx === focusedIdx ? styles['focused'] : ''}`}
                    role="option"
                    aria-selected={idx === focusedIdx}
                    onClick={() => accept([item])}
                    onMouseMove={() => setFocusedIdx(idx)}
                  >
                    {!query && mruIds.includes(item.id) && <span className={styles['mruDot']} />}
                    <span className={styles['itemLabel']}>{item.label}</span>
                    {item.description && (
                      <span className={styles['itemDesc']}>{item.description}</span>
                    )}
                    {item.keybinding && (
                      <span className={styles['itemKeybinding']}>{item.keybinding}</span>
                    )}
                  </button>
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
    const d = svc.onDidChangeState((s) => setPanelState(s))
    setPanelState(svc.currentState)
    return () => d.dispose()
  }, [svc])

  if (!panelState) return null

  const close = () => svc.hide()

  return createPortal(
    <div className={styles['overlay']} onClick={close} data-testid="quick-input-overlay">
      <div onClick={(e) => e.stopPropagation()}>
        {panelState.type === 'pick' ? (
          <QuickPickPanel state={panelState} onClose={close} />
        ) : (
          <InputPanel state={panelState} onClose={close} />
        )}
      </div>
    </div>,
    document.body,
  )
}
