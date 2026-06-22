/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatFindWidget — the floating in-session find bar, modeled on Monaco's find
 *  widget. Pure presentation: it renders a controlled input, a match counter and
 *  prev / next / close buttons, and reports keystrokes / clicks via callbacks.
 *  All search state lives in ChatScroll; this component holds none.
 *
 *  Enter / Shift+Enter / Escape are handled here on the input (Monaco's native
 *  feel) and stop propagation so they don't reach global keybindings. F3 /
 *  Shift+F3 are intentionally NOT handled here — they bubble to the global
 *  FindNext / FindPrevious actions so they also work when focus has left the
 *  input but is still inside the chat.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { IconButton } from '@universe-editor/workbench-ui'
import { localize } from '@universe-editor/platform'
import styles from './agents.module.css'

export interface ChatFindWidgetProps {
  readonly query: string
  readonly count: number
  /** 0-based index of the current match; -1 when there are none. */
  readonly currentIndex: number
  readonly onQueryChange: (query: string) => void
  readonly onNext: () => void
  readonly onPrev: () => void
  readonly onClose: () => void
  /** Overrides the widget's container class so hosts can re-position it. */
  readonly className?: string | undefined
}

export function ChatFindWidget({
  query,
  count,
  currentIndex,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
  className,
}: ChatFindWidgetProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) onPrev()
      else onNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const label =
    count > 0
      ? localize('acp.find.count', '{current} of {total}', {
          current: currentIndex + 1,
          total: count,
        })
      : localize('acp.find.noResults', 'No results')

  const disabled = count === 0

  return (
    <div
      className={className ?? styles['findWidget']}
      data-find-widget
      data-testid="acp-find-widget"
    >
      <input
        ref={inputRef}
        type="text"
        className={styles['findInput']}
        value={query}
        placeholder={localize('acp.find.placeholder', 'Find')}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        data-testid="acp-find-input"
      />
      <span className={styles['findCount']} data-testid="acp-find-count">
        {label}
      </span>
      <IconButton
        label={localize('acp.find.previous', 'Previous match (Shift+F3)')}
        onClick={onPrev}
        disabled={disabled}
        data-testid="acp-find-prev"
      >
        <ChevronUp size={14} strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={localize('acp.find.next', 'Next match (F3)')}
        onClick={onNext}
        disabled={disabled}
        data-testid="acp-find-next"
      >
        <ChevronDown size={14} strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={localize('acp.find.close', 'Close (Esc)')}
        onClick={onClose}
        data-testid="acp-find-close"
      >
        <X size={14} strokeWidth={1.75} />
      </IconButton>
    </div>
  )
}
