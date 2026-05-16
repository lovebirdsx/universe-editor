/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Sets up the standard ContextKeys consumed by built-in commands and menus:
 *   - isWindows / isMac / isLinux  (platform identity)
 *   - sideBarVisible / secondarySideBarVisible / panelVisible  (Part visibility)
 *   - activeEditorId / hasActiveEditor                          (editor state)
 *   - workbenchReady / workbenchRestored                        (lifecycle gates)
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  IContextKeyService,
  IEditorService,
  IHostService,
  ILayoutService,
  ILifecycleService,
  IWorkbenchContribution,
  LifecyclePhase,
  PartId,
} from '@universe-editor/platform'

export class ContextKeyContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IHostService hostService: IHostService,
    @ILayoutService layoutService: ILayoutService,
    @IEditorService editorService: IEditorService,
    @ILifecycleService lifecycleService: ILifecycleService,
  ) {
    super()

    // -- platform keys (constant for the session)
    const platform = hostService.platform
    contextKeyService.createKey<boolean>('isWindows', platform === 'win32')
    contextKeyService.createKey<boolean>('isMac', platform === 'darwin')
    contextKeyService.createKey<boolean>('isLinux', platform === 'linux')

    // -- Part visibility keys
    const sideBarVisible = contextKeyService.createKey<boolean>('sideBarVisible', false)
    const secondarySideBarVisible = contextKeyService.createKey<boolean>(
      'secondarySideBarVisible',
      false,
    )
    const panelVisible = contextKeyService.createKey<boolean>('panelVisible', false)
    this._register(
      autorun((reader) => {
        const visible = layoutService.visible.read(reader)
        sideBarVisible.set(visible[PartId.SideBar])
        secondarySideBarVisible.set(visible[PartId.SecondarySideBar])
        panelVisible.set(visible[PartId.Panel])
      }),
    )

    // -- editor state keys
    const activeEditorId = contextKeyService.createKey<string>('activeEditorId', undefined)
    const hasActiveEditor = contextKeyService.createKey<boolean>('hasActiveEditor', false)
    this._register(
      autorun((reader) => {
        const editor = editorService.activeEditor.read(reader)
        if (editor) {
          activeEditorId.set(editor.id)
          hasActiveEditor.set(true)
        } else {
          activeEditorId.reset()
          hasActiveEditor.set(false)
        }
      }),
    )

    // -- lifecycle phase keys
    const workbenchReady = contextKeyService.createKey<boolean>('workbenchReady', false)
    const workbenchRestored = contextKeyService.createKey<boolean>('workbenchRestored', false)
    if (lifecycleService.phase >= LifecyclePhase.Ready) {
      workbenchReady.set(true)
    } else {
      void lifecycleService.when(LifecyclePhase.Ready).then(() => workbenchReady.set(true))
    }
    if (lifecycleService.phase >= LifecyclePhase.Restored) {
      workbenchRestored.set(true)
    } else {
      void lifecycleService.when(LifecyclePhase.Restored).then(() => workbenchRestored.set(true))
    }
  }
}
