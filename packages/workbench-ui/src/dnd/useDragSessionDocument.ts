import { useContext, useEffect } from 'react'
import { DragSessionContext } from './DragSessionContext.js'

/**
 * Attach the gesture's terminal cleanup to one workbench document.
 *
 * Every workbench window is its own Document, and a drop can land in a
 * different one from the drag source. The provider mounts this for the main
 * document; each auxiliary window's portal calls it for its own document, so
 * `drop`, `dragend` and Escape clear/cancel the shared session no matter which
 * window received them.
 *
 * Listeners are registered in the bubble phase on purpose: React's `onDragEnd`
 * on the tab runs first, then this clear runs — the drag-out handler can still
 * read the payload and the consumed/cancelled flags.
 */
export function useDragSessionDocument(targetDocument?: Document): void {
  const ctx = useContext(DragSessionContext)

  useEffect(() => {
    if (!ctx) return
    const doc = targetDocument ?? (typeof document === 'undefined' ? undefined : document)
    if (!doc) return
    // Listen on the window as well as the document: a terminal event can be
    // targeted at either one, and only the document listener sees events from
    // nodes (the window listener sees both). Happy-dom reports no `defaultView`
    // for the main document, so fall back to the global window.
    const targets: EventTarget[] = [doc]
    const view = doc.defaultView
    if (view && (view as unknown) !== (doc as unknown)) {
      targets.push(view)
    } else if (typeof window !== 'undefined' && doc === globalThis.document) {
      targets.push(window)
    }
    const clear = (): void => ctx.clearPayload()
    const onKeyDown = (event: Event): void => {
      if ((event as KeyboardEvent).key !== 'Escape') return
      // A cancelled gesture must never be mistaken for "released outside every
      // window" by the tab drag-out handler.
      if (ctx.payload !== undefined) ctx.markCancelled()
    }
    for (const target of targets) {
      target.addEventListener('drop', clear)
      target.addEventListener('dragend', clear)
      target.addEventListener('keydown', onKeyDown, true)
    }
    return () => {
      for (const target of targets) {
        target.removeEventListener('drop', clear)
        target.removeEventListener('dragend', clear)
        target.removeEventListener('keydown', onKeyDown, true)
      }
    }
  }, [ctx, targetDocument])
}
