/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Installs the Vim dispatcher as the `workbench-ui` window-capture provider.
 *  One provider serves every workbench document, so opening an auxiliary
 *  window does not replace the main window's handler; each document gets its
 *  own dispatcher and focusin reset.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useRef } from 'react'
import { ICommandService, IContextKeyService } from '@universe-editor/platform'
import {
  ensureNavigationDocument,
  getActiveVimSurface,
  onDidChangeVimSurfaces,
  setVimKeyHandlerProvider,
} from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { IKeyboardDebugService } from '../../services/keybinding/keyboardDebugService.js'
import { IVimModeService } from '../../services/vim/vimModeService.js'
import { VimDispatcher } from './vimDispatcher.js'

const dispatchers = new Map<Document, VimDispatcher>()

function ensureGlobalProvider(): void {
  setVimKeyHandlerProvider((doc, event) => dispatchers.get(doc)?.handleKeyDown(doc, event) ?? false)
}

export function useVimDispatcher(targetDocument: Document = document): void {
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const vimModeService = useService(IVimModeService)
  const keyboardDebugService = useService(IKeyboardDebugService)
  const dispatcherRef = useRef<VimDispatcher | null>(null)
  if (dispatcherRef.current === null) {
    dispatcherRef.current = new VimDispatcher({
      commandService,
      contextKeyService,
      vimModeService,
      keyboardDebugService,
    })
  }

  // Layout effect, like the global keybinding handler: auxiliary windows must
  // accept Vim keys as soon as their content commits.
  useLayoutEffect(() => {
    const dispatcher = dispatcherRef.current!
    dispatchers.set(targetDocument, dispatcher)
    ensureGlobalProvider()
    const unpin = ensureNavigationDocument(targetDocument)

    const refresh = (): void => {
      const active = getActiveVimSurface(targetDocument)
      vimModeService.activateSurface(
        active === undefined
          ? undefined
          : {
              surfaceKey: active.surfaceKey,
              kind: active.surface.kind,
              id: active.surface.id,
              defaultMode: active.surface.defaultMode,
            },
      )
    }

    const onFocusIn = (): void => {
      // A count typed in one surface must not carry into the next.
      dispatcher.resetAll()
      refresh()
    }
    let focusOutTimer: ReturnType<typeof setTimeout> | undefined
    const onFocusOut = (): void => {
      if (focusOutTimer !== undefined) clearTimeout(focusOutTimer)
      // focusout fires before activeElement settles on the new target.
      focusOutTimer = setTimeout(() => {
        focusOutTimer = undefined
        refresh()
      }, 0)
    }

    targetDocument.addEventListener('focusin', onFocusIn, true)
    targetDocument.addEventListener('focusout', onFocusOut, true)
    const surfaceSubscription = onDidChangeVimSurfaces(targetDocument, refresh)
    refresh()

    return () => {
      if (focusOutTimer !== undefined) clearTimeout(focusOutTimer)
      targetDocument.removeEventListener('focusin', onFocusIn, true)
      targetDocument.removeEventListener('focusout', onFocusOut, true)
      surfaceSubscription.dispose()
      unpin.dispose()
      dispatchers.delete(targetDocument)
      if (dispatchers.size === 0) setVimKeyHandlerProvider(undefined)
    }
  }, [commandService, contextKeyService, keyboardDebugService, targetDocument, vimModeService])
}
