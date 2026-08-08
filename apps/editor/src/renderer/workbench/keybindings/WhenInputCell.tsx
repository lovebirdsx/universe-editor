/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WhenInputCell — inline when-expression editor for the Keyboard Shortcuts
 *  table's When column, mirroring VSCode's WhenInputWidget: focus + select-all
 *  on entry, context-key autocomplete anchored under the input (arrow keys
 *  navigate, Enter/Tab accept — an accepting Enter does NOT submit), Enter
 *  without visible suggestions commits, Escape/blur cancels. The `whenFocus`
 *  context key is held for the whole editing session via onFocusChange.
 *--------------------------------------------------------------------------------------------*/

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { localize } from '@universe-editor/platform'
import { PopoverList } from '@universe-editor/workbench-ui'
import {
  collectKnownContextKeys,
  type IKnownContextKey,
} from '../../services/keybindings/knownContextKeys.js'
import styles from './KeybindingsEditor.module.css'

// The when token under the cursor: an optional leading '!' plus identifier
// chars (context keys use dots, e.g. `editorTextFocus`, `config.foo.bar`).
const TOKEN_REGEX = /!?[a-zA-Z0-9_.]*$/

export interface WhenInputCellProps {
  readonly initialValue: string
  readonly onCommit: (when: string) => void
  readonly onCancel: () => void
  /** Drives the `whenFocus` context key: true for the whole editing session. */
  readonly onFocusChange: (focused: boolean) => void
}

export function WhenInputCell({
  initialValue,
  onCommit,
  onCancel,
  onFocusChange,
}: WhenInputCellProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [cursor, setCursor] = useState(initialValue.length)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const exitedRef = useRef(false)

  const candidates = useMemo(() => collectKnownContextKeys(), [])

  useEffect(() => {
    const input = inputRef.current
    input?.focus()
    input?.select()
    onFocusChange(true)
    return () => onFocusChange(false)
  }, [onFocusChange])

  const tokenMatch = TOKEN_REGEX.exec(value.slice(0, cursor))?.[0] ?? ''
  const tokenText = tokenMatch.startsWith('!') ? tokenMatch.slice(1) : tokenMatch
  const suggestions = useMemo(() => {
    if (tokenMatch === '') return []
    const lower = tokenText.toLowerCase()
    return candidates.filter(
      (c) => c.key.toLowerCase().startsWith(lower) && c.key.toLowerCase() !== lower,
    )
  }, [candidates, tokenMatch, tokenText])
  const suggestionsVisible = suggestions.length > 0

  // Blur fires both on genuine exit and right after a commit/cancel unmount —
  // funnel every exit through this guard so the parent hears it exactly once.
  const exit = (action: () => void) => {
    if (exitedRef.current) return
    exitedRef.current = true
    action()
  }

  const acceptSuggestion = (candidate: IKnownContextKey) => {
    const start = cursor - tokenText.length
    const next = value.slice(0, start) + candidate.key + value.slice(cursor)
    const nextCursor = start + candidate.key.length
    setValue(next)
    setCursor(nextCursor)
    setActiveIndex(0)
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (suggestionsVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        const candidate = suggestions[Math.min(activeIndex, suggestions.length - 1)]
        if (candidate) acceptSuggestion(candidate)
        return
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      exit(() => onCommit(value.trim()))
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      exit(onCancel)
    }
  }

  return (
    <div className={styles['whenEditor']}>
      <input
        ref={inputRef}
        className={styles['whenInput']}
        value={value}
        aria-label={localize('keybindings.whenInput.ariaLabel', 'When expression')}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value)
          setCursor(e.target.selectionStart ?? e.target.value.length)
          setActiveIndex(0)
        }}
        onSelect={(e) => {
          setCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => exit(onCancel)}
      />
      {suggestionsVisible && (
        <PopoverList
          items={suggestions}
          activeIndex={Math.min(activeIndex, suggestions.length - 1)}
          getKey={(item) => item.key}
          onSelect={acceptSuggestion}
          onHover={setActiveIndex}
          className={styles['whenSuggestions']}
          data-testid="keybindings-when-suggestions"
          aria-label={localize('keybindings.whenInput.suggestions', 'Context keys')}
          renderItem={(item) => (
            <>
              <span className={styles['whenSuggestionKey']}>{item.key}</span>
              {item.description !== undefined && (
                <span className={styles['whenSuggestionDescription']}>{item.description}</span>
              )}
            </>
          )}
        />
      )}
    </div>
  )
}
