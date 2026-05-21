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
import type { IQuickPickItem } from '@universe-editor/platform'
import { useService } from '../useService.js'
import {
  QuickInputService,
  type QuickPickState,
} from '../../services/quickInput/QuickInputService.js'
import styles from './QuickInput.module.css'

function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++
  }
  return qi === q.length
}

// Exported for unit tests so prefix / filtering behavior can be exercised
// without booting the full portal + service plumbing.
export function QuickPickPanel({ state, onClose }: { state: QuickPickState; onClose: () => void }) {
  const prefix = state.prefix ?? ''
  const [query, setQuery] = useState(prefix)
  const [focusedIdx, setFocusedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mruIds = state.mruIds ?? []

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
            fuzzyMatch(item.label + ' ' + (item.description ?? ''), deferredFilterText),
          ),
    [prefixMissing, state.items, deferredFilterText],
  )

  const sortedFiltered = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        const ai = mruIds.indexOf(a.id)
        const bi = mruIds.indexOf(b.id)
        if (ai === -1 && bi === -1) return 0
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, mruIds.join(',')],
  )

  const ITEM_HEIGHT = 32

  const virtualizer = useVirtualizer({
    count: sortedFiltered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 5,
  })

  useEffect(() => {
    setFocusedIdx(0)
  }, [query])

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

  const PAGE_SIZE = 8

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const len = sortedFiltered.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIdx((i) => (len === 0 ? 0 : (i + 1) % len))
    } else if (e.key === 'ArrowUp') {
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
