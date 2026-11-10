import { useEffect, useState } from 'react'
import { watchShellCacheFallback } from './pwa.js'

/**
 * True when the service worker served this document from its cache. Used to
 * explain a UI that looks alive while the gateway is unreachable (for example
 * after the phone lost its certificate exception).
 */
export function useShellCacheFallback(): boolean {
  const [fromCache, setFromCache] = useState(false)
  useEffect(() => watchShellCacheFallback(() => setFromCache(true)), [])
  return fromCache
}
