/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WhenInputCell — inline when-expression editor for the Keyboard Shortcuts
 *  table's When column, mirroring VSCode's WhenInputWidget: focus + select-all
 *  on entry, context-key autocomplete anchored to the input (arrow keys
 *  navigate, Enter/Tab accept — an accepting Enter does NOT submit), Enter
 *  without visible suggestions commits, Escape first hides visible suggestions
 *  then cancels, blur cancels. The `whenFocus` context key is held for the
 *  whole editing session via onFocusChange.
 *
 *  The suggestion list is portaled to <body> (VSCode renders it into the
 *  editor's overflowWidgetsDomNode for the same reason): virtualized rows are
 *  transform-positioned — each its own stacking context — and the scroll
 *  container clips overflow, so an in-row popup paints under later rows and
 *  gets clipped at the viewport edge.
 *--------------------------------------------------------------------------------------------*/

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react'
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
  /** `viaKeyboard` distinguishes an explicit Escape from a blur exit. */
  readonly onCancel: (viaKeyboard: boolean) => void
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
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
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
  const suggestionsVisible = !suggestionsDismissed && suggestions.length > 0

  const { refs, floatingStyles } = useFloating({
    open: suggestionsVisible,
    placement: 'bottom-start',
    strategy: 'fixed',
    // autoUpdate keeps the popup glued to the input while the table scrolls.
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(2),
      flip({ padding: 8 }),
      shift({ mainAxis: false, crossAxis: true, padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, rects, elements }) {
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(0, Math.min(340, availableHeight))}px`,
            minWidth: `${Math.max(240, rects.reference.width)}px`,
          })
        },
      }),
    ],
  })

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
        e.stopPropagation()
        setActiveIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
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
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSuggestionsDismissed(true)
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
      exit(() => onCancel(true))
    }
  }

  return (
    <div className={styles['whenEditor']}>
      <input
        ref={(el) => {
          inputRef.current = el
          refs.setReference(el)
        }}
        className={styles['whenInput']}
        value={value}
        aria-label={localize('keybindings.whenInput.ariaLabel', 'When expression')}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value)
          setCursor(e.target.selectionStart ?? e.target.value.length)
          setActiveIndex(0)
          setSuggestionsDismissed(false)
        }}
        onSelect={(e) => {
          setCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => exit(() => onCancel(false))}
      />
      {suggestionsVisible && (
        <FloatingPortal>
          <PopoverList
            ref={refs.setFloating}
            style={{ zIndex: 'var(--z-popover)', ...floatingStyles }}
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
        </FloatingPortal>
      )}
    </div>
  )
}
