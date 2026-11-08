import { useEffect, useState } from 'react'

/**
 * iPhone Safari has no element fullscreen (iPadOS gained it in 16.4), so the
 * settings UI falls back to "add to home screen" guidance when unsupported.
 */
export function isFullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false
  return (
    document.fullscreenEnabled === true &&
    typeof document.documentElement.requestFullscreen === 'function'
  )
}

export function isFullscreenActive(): boolean {
  return typeof document !== 'undefined' && Boolean(document.fullscreenElement)
}

export interface FullscreenState {
  readonly supported: boolean
  readonly active: boolean
  readonly toggle: () => void
}

export function useFullscreen(): FullscreenState {
  const [supported] = useState(isFullscreenSupported)
  const [active, setActive] = useState(isFullscreenActive)

  useEffect(() => {
    if (!supported) return
    const update = (): void => setActive(isFullscreenActive())
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [supported])

  const toggle = (): void => {
    try {
      const request = isFullscreenActive()
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      void Promise.resolve(request).catch(() => undefined)
    } catch {
      // Browsers reject a request that no longer has a live user gesture.
    }
  }

  return { supported, active, toggle }
}
