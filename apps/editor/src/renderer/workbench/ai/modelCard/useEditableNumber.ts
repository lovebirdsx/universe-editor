/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Numeric draft editing for the model knowledge cards — the number sibling of
 *  `useEditableText`. The draft is a string while editing so an invalid
 *  intermediate state ("12a" mid-keystroke) can be shown and fixed instead of
 *  being silently coerced, and it is parsed strictly: no parseInt prefix
 *  parsing. An empty draft commits `undefined` (clear the field), an invalid
 *  one commits nothing, and props are only mirrored into the draft while
 *  unfocused so a hot reload of aiSettings.json cannot clobber an edit.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface EditableNumber {
  readonly value: string
  /** True while the draft is not a valid non-negative integer (drives Input's `invalid`). */
  readonly invalid: boolean
  readonly onChange: (value: string) => void
  readonly onFocus: () => void
  readonly onBlur: () => void
  readonly onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
}

/**
 * A numeric draft that commits on blur/Enter, reverts on Escape, and survives the
 * aiSettings.json hot reload — the text sibling of useEditableText.
 */
export function useEditableNumber(
  external: number | undefined,
  commit: (value: number | undefined) => void,
): EditableNumber {
  const [value, setValue] = useState(external === undefined ? '' : String(external))
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)

  // Mirror the external value only while unfocused, or a hot reload arriving
  // mid-edit would overwrite what the user is typing.
  useEffect(() => {
    if (!editing) setValue(external === undefined ? '' : String(external))
  }, [external, editing])

  const trimmed = value.trim()
  const invalid = trimmed !== '' && !/^\d+$/.test(trimmed)

  const onBlur = useCallback(() => {
    if (cancelled.current) {
      cancelled.current = false
      setEditing(false)
      setValue(external === undefined ? '' : String(external))
      return
    }
    const draft = value.trim()
    if (draft === '') {
      setEditing(false)
      if (external !== undefined) commit(undefined)
      return
    }
    // Do not commit an invalid draft: stay in the editing state so the mirrored
    // effect leaves it visible for the user to fix, instead of silently
    // dropping it or coercing it to some other number.
    if (!/^\d+$/.test(draft)) return
    setEditing(false)
    const next = Number(draft)
    if (next !== external) commit(next)
  }, [commit, external, value])

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      cancelled.current = true
      e.currentTarget.blur()
    }
  }, [])

  return { value, invalid, onChange: setValue, onFocus: () => setEditing(true), onBlur, onKeyDown }
}
