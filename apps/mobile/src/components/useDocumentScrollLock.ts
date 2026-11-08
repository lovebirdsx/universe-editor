import { useEffect } from 'react'

const LOCK_CLASS = 'is-scroll-locked'
let locks = 0

/**
 * Freezes the document scroller while a modal overlay is mounted. Without it a
 * pan on the backdrop scrolls the page behind (visible through the dim layer).
 * Ref-counted so nested overlays restore the page exactly once.
 */
export function useDocumentScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const root = document.documentElement
    locks += 1
    root.classList.add(LOCK_CLASS)
    return () => {
      locks -= 1
      if (locks === 0) root.classList.remove(LOCK_CLASS)
    }
  }, [active])
}
