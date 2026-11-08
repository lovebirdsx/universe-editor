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
