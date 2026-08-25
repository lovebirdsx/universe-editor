/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Field-editing plumbing shared by every section of a provider card and the
 *  model knowledge cards. One save paradigm: a commit writes through
 *  updateEntry immediately and stamps which field was written so a "Saved"
 *  flag can render next to that field alone.
 *
 *  `useEditableText` additionally guards the input against the aiSettings.json
 *  file watcher: a hot reload arriving mid-edit must not overwrite what the user
 *  is typing, so props are only mirrored into the draft while unfocused.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AiProviderEntry } from '@universe-editor/platform'

export type ProviderPatch = (entry: AiProviderEntry) => AiProviderEntry

export interface SavedStamp {
  readonly field: string
  readonly at: number
}

/**
 * Write a field, or delete it when the value is empty — an absent key is the
 * only way to mean "inherit / use the default". Only `undefined` and `''` count
 * as empty, so `0` and `false` are written through.
 */
export function patchField<T extends object, K extends keyof T>(
  field: K,
  value: T[K] | undefined,
): (entry: T) => T {
  return (entry) => {
    if (value !== undefined && value !== '') return { ...entry, [field]: value }
    if (!(field in entry)) return entry
    const next = { ...entry }
    Reflect.deleteProperty(next, field)
    return next
  }
}

/** Generic core of `useProviderField`: the same save-and-stamp pipeline for any entry type. */
export function useEntryField<T extends object>(
  updateEntry: (build: (entry: T) => T) => Promise<void>,
) {
  const [saved, setSaved] = useState<SavedStamp | undefined>(undefined)

  /** Flag a field as written by something other than updateEntry (setApiKey). */
  const stamp = useCallback((field: string) => setSaved({ field, at: Date.now() }), [])

  const apply = useCallback(
    async (field: string, build: (entry: T) => T) => {
      await updateEntry(build)
      setSaved({ field, at: Date.now() })
    },
    [updateEntry],
  )

  const setField = useCallback(
    async <K extends keyof T>(field: K, value: T[K] | undefined) => {
      await apply(String(field), patchField<T, K>(field, value))
    },
    [apply],
  )

  return { setField, apply, stamp, saved }
}

export function useProviderField(updateEntry: (build: ProviderPatch) => Promise<void>) {
  return useEntryField<AiProviderEntry>(updateEntry)
}

export interface EditableText {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onFocus: () => void
  readonly onBlur: () => void
  readonly onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
}

/** A text draft that commits on blur/Enter, reverts on Escape, and survives hot reloads. */
export function useEditableText(
  external: string | undefined,
  commit: (value: string) => void,
): EditableText {
  const [value, setValue] = useState(external ?? '')
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!editing) setValue(external ?? '')
  }, [external, editing])

  const onBlur = useCallback(() => {
    setEditing(false)
    if (cancelled.current) {
      cancelled.current = false
      setValue(external ?? '')
      return
    }
    const trimmed = value.trim()
    if (trimmed !== (external ?? '')) commit(trimmed)
  }, [commit, external, value])

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      cancelled.current = true
      e.currentTarget.blur()
    }
  }, [])

  return { value, onChange: setValue, onFocus: () => setEditing(true), onBlur, onKeyDown }
}
