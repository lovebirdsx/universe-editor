/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Stable surface keys for per-surface mode memory. Hosts that know a durable
 *  view id pass it in (`vimSurfaceId`); everything else gets an auto key that
 *  lives for the component instance.
 *--------------------------------------------------------------------------------------------*/

import { useRef } from 'react'

let nextAutoSurfaceId = 1

/** `<kind>:<id>` for explicit ids, `<kind>:auto:<n>` otherwise. */
export function useVimSurfaceKey(kind: string, explicitId?: string | undefined): string {
  const autoRef = useRef<string | null>(null)
  if (autoRef.current === null) autoRef.current = `${kind}:auto:${nextAutoSurfaceId++}`
  return explicitId === undefined || explicitId.length === 0
    ? autoRef.current
    : `${kind}:${explicitId}`
}
