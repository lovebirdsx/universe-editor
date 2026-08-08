/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  useFullCommitMessages — lazy full-commit-message cache for the graph views.
 *  The commit list DTOs carry only the subject line; the full body is fetched on
 *  demand (hover prefetch for the tooltip, or the Copy action). Results are
 *  cached per id and in-flight requests coalesce.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useRef, useState } from 'react'

export interface FullCommitMessages {
  /** Cached full message, or undefined when not fetched yet. */
  get: (id: string) => string | undefined
  /** Fetch (or reuse) the full message; bumps the hook's state once cached so
   *  rows re-render with the tooltip. */
  load: (id: string) => Promise<string | null>
}

export function useFullCommitMessages(
  fetchBody: (id: string) => Promise<string | null>,
): FullCommitMessages {
  const cacheRef = useRef(new Map<string, string>())
  const inFlightRef = useRef(new Map<string, Promise<string | null>>())
  // Version bump re-renders the consumer when a body lands; rows are memoised,
  // so only the one whose `fullMessage` prop changed actually reconciles.
  const [, setVersion] = useState(0)
  const fetchBodyRef = useRef(fetchBody)
  fetchBodyRef.current = fetchBody

  const load = useCallback((id: string): Promise<string | null> => {
    const cached = cacheRef.current.get(id)
    if (cached !== undefined) return Promise.resolve(cached)
    const inFlight = inFlightRef.current.get(id)
    if (inFlight) return inFlight
    const request = fetchBodyRef
      .current(id)
      .then((body) => {
        inFlightRef.current.delete(id)
        if (body !== null) {
          cacheRef.current.set(id, body)
          setVersion((v) => v + 1)
        }
        return body
      })
      .catch(() => {
        inFlightRef.current.delete(id)
        return null
      })
    inFlightRef.current.set(id, request)
    return request
  }, [])

  const get = useCallback((id: string) => cacheRef.current.get(id), [])

  // Stable identity: consumers pass load/get into memoised rows and menu
  // callbacks, a fresh object each render would bust those memos.
  return useMemo(() => ({ get, load }), [get, load])
}
