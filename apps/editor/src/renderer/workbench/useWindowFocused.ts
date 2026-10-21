/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useWindowFocused — reactive synthesized window-focus state (see isWindowFocused).
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react'
import { useOwnerDocument } from '@universe-editor/workbench-ui'
import { isDocumentFocused } from './domUtils.js'

export function useWindowFocused(): boolean {
  const doc = useOwnerDocument()
  return useSyncExternalStore(
    (onChange) => {
      const view = doc?.defaultView
      view?.addEventListener('focus', onChange)
      view?.addEventListener('blur', onChange)
      doc?.addEventListener('visibilitychange', onChange)
      return () => {
        view?.removeEventListener('focus', onChange)
        view?.removeEventListener('blur', onChange)
        doc?.removeEventListener('visibilitychange', onChange)
      }
    },
    () => isDocumentFocused(doc),
    () => isDocumentFocused(doc),
  )
}
