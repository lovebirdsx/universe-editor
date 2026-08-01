/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Search-query state for the settings editor, persisted to GLOBAL storage so
 *  the query survives editor-tab switches and window reloads (VSCode memento
 *  behavior). Writes are debounced; clearing the query removes the key; an
 *  unmount (tab switch) flushes the pending write immediately.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { IStorageService, StorageScope } from '@universe-editor/platform'

const QUERY_STORAGE_KEY = 'settingsEditor.query'
const SAVE_DEBOUNCE_MS = 200

export function useSettingsQueryState(storage: IStorageService): {
  query: string
  setQuery: (q: string) => void
} {
  const [query, setQueryState] = useState('')
  // Guard against writing the initial '' over the stored value before the
  // restore read resolves (the AiSettingsEditor pattern).
  const restoredRef = useRef(false)
  const latestRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let active = true
    void storage.get<string>(QUERY_STORAGE_KEY, StorageScope.GLOBAL).then((stored) => {
      if (!active) return
      if (stored) {
        latestRef.current = stored
        setQueryState(stored)
      }
      restoredRef.current = true
    })
    return () => {
      active = false
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      // Flush on unmount: the editor unmounts when its tab goes inactive, and a
      // pending debounce would otherwise lose the last keystrokes.
      if (restoredRef.current) {
        const q = latestRef.current
        if (q) void storage.set(QUERY_STORAGE_KEY, q, StorageScope.GLOBAL)
        else void storage.remove(QUERY_STORAGE_KEY, StorageScope.GLOBAL)
      }
    }
  }, [storage])

  const setQuery = useCallback(
    (q: string) => {
      latestRef.current = q
      setQueryState(q)
      if (!restoredRef.current) return
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined
        if (q) void storage.set(QUERY_STORAGE_KEY, q, StorageScope.GLOBAL)
        else void storage.remove(QUERY_STORAGE_KEY, StorageScope.GLOBAL)
      }, SAVE_DEBOUNCE_MS)
    },
    [storage],
  )

  return { query, setQuery }
}
