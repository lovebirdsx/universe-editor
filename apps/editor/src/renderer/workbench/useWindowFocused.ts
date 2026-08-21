/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useWindowFocused — reactive synthesized window-focus state (see isWindowFocused).
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react'
import { isWindowFocused } from './domUtils.js'

export function useWindowFocused(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('focus', onChange)
      window.addEventListener('blur', onChange)
      document.addEventListener('visibilitychange', onChange)
      return () => {
        window.removeEventListener('focus', onChange)
        window.removeEventListener('blur', onChange)
        document.removeEventListener('visibilitychange', onChange)
      }
    },
    isWindowFocused,
    isWindowFocused,
  )
}
