import { useEffect, useState } from 'react'

/**
 * iOS keeps the layout viewport at full height when the keyboard opens; only
 * `visualViewport` shrinks. Pinning the session page to it keeps the composer
 * above the keyboard instead of hidden behind it.
 */
export function useVisualViewportHeight(): number | undefined {
  const read = (): number | undefined => {
    if (typeof window === 'undefined') return undefined
    return window.visualViewport?.height
  }
  const [height, setHeight] = useState<number | undefined>(read)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const viewport = window.visualViewport
    if (viewport === null || viewport === undefined) return
    const update = (): void => setHeight(viewport.height)
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])

  return height
}
