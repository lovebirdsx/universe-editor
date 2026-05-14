import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { IQuickInputService } from '@universe-editor/platform'
import type { IQuickPickItem } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { QuickInputService, type QuickPickState } from './QuickInputService.js'
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

function QuickPickPanel({ state, onClose }: { state: QuickPickState; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [focusedIdx, setFocusedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = (state.items ?? []).filter((item) =>
    fuzzyMatch(item.label + ' ' + (item.description ?? ''), query),
  )

  useEffect(() => {
    setFocusedIdx(0)
  }, [query])

  const accept = useCallback(
    (items: IQuickPickItem[]) => {
      state.onAccept?.(items)
      onClose()
    },
    [state, onClose],
  )

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      state.onHide?.()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIdx((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const item = filtered[focusedIdx]
      if (item) accept([item])
    }
  }

  return (
    <div className={styles['container']} role="dialog" aria-modal>
      <div className={styles['inputRow']}>
        <input
          ref={inputRef}
          className={styles['input']}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKey}
          placeholder={state.placeholder ?? 'Type to filter…'}
          aria-label={state.placeholder ?? 'Quick pick input'}
        />
      </div>
      <div className={styles['list']} role="listbox">
        {filtered.length === 0 ? (
          <p className={styles['empty']}>No results</p>
        ) : (
          filtered.map((item, idx) => (
            <button
              key={item.id}
              className={`${styles['item']} ${idx === focusedIdx ? styles['focused'] : ''}`}
              role="option"
              aria-selected={idx === focusedIdx}
              onClick={() => accept([item])}
              onMouseEnter={() => setFocusedIdx(idx)}
            >
              <span className={styles['itemLabel']}>{item.label}</span>
              {item.description && <span className={styles['itemDesc']}>{item.description}</span>}
            </button>
          ))
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
    if (e.key === 'Escape') {
      state.onHide?.()
      onClose()
    } else if (e.key === 'Enter') {
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
    <div className={styles['container']} role="dialog" aria-modal>
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
  const [panelState, setPanelState] = useState<QuickPickState | null>(null)

  useEffect(() => {
    const svc = quickInputService as QuickInputService
    svc.registerShowFn(setPanelState)
  }, [quickInputService])

  if (!panelState) return null

  return createPortal(
    <div className={styles['overlay']} onClick={() => setPanelState(null)}>
      <div onClick={(e) => e.stopPropagation()}>
        {panelState.type === 'pick' ? (
          <QuickPickPanel state={panelState} onClose={() => setPanelState(null)} />
        ) : (
          <InputPanel state={panelState} onClose={() => setPanelState(null)} />
        )}
      </div>
    </div>,
    document.body,
  )
}
