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
import {
  currentWorkbenchDocumentOrUndefined,
  onDidAddWorkbenchDocument,
  onDidRemoveWorkbenchDocument,
} from '../../services/windows/workbenchDocuments.js'
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

  // Layout effect, like the global keybinding handler: auxiliary windows must
  // accept Vim keys as soon as their content commits.
  useLayoutEffect(() => {
    const dispatcher =
      dispatcherRef.current ??
      new VimDispatcher({
        commandService,
        contextKeyService,
        vimModeService,
        keyboardDebugService,
      })
    dispatcherRef.current = dispatcher
    dispatchers.set(targetDocument, dispatcher)
    ensureGlobalProvider()
    const unpin = ensureNavigationDocument(targetDocument)

    const refresh = (): void => {
      // Every workbench window installs its own dispatcher. Only the focused
      // document may publish the active surface: a stale focusout timer from
      // the other window would otherwise overwrite the context keys / status
      // bar and let Insert-mode keys fall through as User bindings.
      const activeDocument = currentWorkbenchDocumentOrUndefined()
      if (activeDocument !== undefined && activeDocument !== targetDocument) return
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

    let focusOutTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = (): void => {
      if (focusOutTimer !== undefined) clearTimeout(focusOutTimer)
      // focusout fires before activeElement settles on the new target; the
      // window/document registry also updates during that window, so defer.
      focusOutTimer = setTimeout(() => {
        focusOutTimer = undefined
        refresh()
      }, 0)
    }

    const onFocusIn = (): void => {
      // A count typed in one surface must not carry into the next.
      dispatcher.resetAll(targetDocument)
      refresh()
    }

    targetDocument.addEventListener('focusin', onFocusIn, true)
    targetDocument.addEventListener('focusout', scheduleRefresh, true)
    const view = targetDocument.defaultView
    view?.addEventListener('focus', scheduleRefresh)
    const surfaceSubscription = onDidChangeVimSurfaces(targetDocument, refresh)
    // Closing an auxiliary window hands focus back to the main window without
    // a focusin on it; re-evaluate on registry changes too.
    const addDocumentSubscription = onDidAddWorkbenchDocument(scheduleRefresh)
    const removeDocumentSubscription = onDidRemoveWorkbenchDocument(scheduleRefresh)
    refresh()

    return () => {
      if (focusOutTimer !== undefined) clearTimeout(focusOutTimer)
      targetDocument.removeEventListener('focusin', onFocusIn, true)
      targetDocument.removeEventListener('focusout', scheduleRefresh, true)
      view?.removeEventListener('focus', scheduleRefresh)
      surfaceSubscription.dispose()
      addDocumentSubscription.dispose()
      removeDocumentSubscription.dispose()
      unpin.dispose()
      dispatcher.dispose(targetDocument)
      dispatcherRef.current = null
      dispatchers.delete(targetDocument)
      if (dispatchers.size === 0) setVimKeyHandlerProvider(undefined)
    }
  }, [commandService, contextKeyService, keyboardDebugService, targetDocument, vimModeService])
}
