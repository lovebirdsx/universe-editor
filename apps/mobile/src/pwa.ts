export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return
  if (window.isSecureContext !== true) return
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('mobile: service worker registration failed', error)
    })
  })
}

/**
 * Notified when the service worker answered this document's navigation from its
 * cache, meaning the phone may be running a stale build while the network (or
 * the certificate) is broken. The worker also answers an immediate status query
 * so a page loaded before the listener existed still learns the verdict.
 */
export function watchShellCacheFallback(listener: (at: number) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined
  const container = navigator.serviceWorker
  let disposed = false
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as
      | { type?: unknown; fromCache?: unknown; at?: unknown }
      | null
      | undefined
    const fromCache =
      data?.type === 'mobile-shell-from-cache' ||
      (data?.type === 'mobile-shell-status' && data.fromCache === true)
    if (!fromCache) return
    listener(typeof data?.at === 'number' ? data.at : Date.now())
  }
  const ask = (): void => {
    if (disposed) return
    container.controller?.postMessage({ type: 'mobile-shell-status' })
  }
  container.addEventListener('message', onMessage)
  // The first load has no controller yet; ask again once the worker claims it.
  container.addEventListener('controllerchange', ask)
  ask()
  return () => {
    disposed = true
    container.removeEventListener('message', onMessage)
    container.removeEventListener('controllerchange', ask)
  }
}
