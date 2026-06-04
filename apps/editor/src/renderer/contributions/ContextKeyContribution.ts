/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Sets up the standard ContextKeys consumed by built-in commands and menus:
 *   - isWindows / isMac / isLinux  (platform identity)
 *   - activityBarVisible / sideBarVisible / secondarySideBarVisible / panelVisible  (Part visibility)
 *   - activeEditorId / hasActiveEditor                          (editor state)
 *   - activeEditorLanguageId                                     (active file language id)
 *   - editorFocus                                                (Monaco widget DOM focus)
 *   - editorPartMultipleEditorGroups / editorIsOpen
 *   - groupEditorsCount / activeEditorGroupIndex / activeEditorGroupEmpty
 *   - activeEditorIsFirstInGroup / activeEditorIsLastInGroup / activeEditorIsDirty
 *   - workbenchReady / workbenchRestored                        (lifecycle gates)
 *
 *  Per-header keys (`activeViewContainer`, `activeViewContainerLocation`) are
 *  NOT set here — they live on per-header scoped ContextKeyServices owned by
 *  `ViewContainerHeader`, so `MenuId.ViewContainerTitle` actions resolve
 *  independently for the Panel and Secondary Side Bar.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  IContextKeyService,
  IEditorGroupsService,
  IEditorService,
  IHostService,
  ILayoutService,
  ILifecycleService,
  IWorkbenchContribution,
  LifecyclePhase,
  PartId,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'

export class ContextKeyContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IHostService hostService: IHostService,
    @ILayoutService layoutService: ILayoutService,
    @IEditorService editorService: IEditorService,
    @IEditorGroupsService editorGroupsService: IEditorGroupsService,
    @ILifecycleService lifecycleService: ILifecycleService,
  ) {
    super()

    // -- platform keys (constant for the session)
    const platform = hostService.platform
    contextKeyService.createKey<boolean>('isWindows', platform === 'win32')
    contextKeyService.createKey<boolean>('isMac', platform === 'darwin')
    contextKeyService.createKey<boolean>('isLinux', platform === 'linux')

    // -- Part visibility keys
    const activityBarVisible = contextKeyService.createKey<boolean>('activityBarVisible', false)
    const sideBarVisible = contextKeyService.createKey<boolean>('sideBarVisible', false)
    const secondarySideBarVisible = contextKeyService.createKey<boolean>(
      'secondarySideBarVisible',
      false,
    )
    const panelVisible = contextKeyService.createKey<boolean>('panelVisible', false)
    this._register(
      autorun((reader) => {
        const visible = layoutService.visible.read(reader)
        activityBarVisible.set(visible[PartId.ActivityBar])
        sideBarVisible.set(visible[PartId.SideBar])
        secondarySideBarVisible.set(visible[PartId.SecondarySideBar])
        panelVisible.set(visible[PartId.Panel])
      }),
    )

    // -- editor state keys
    const activeEditorId = contextKeyService.createKey<string>('activeEditorId', undefined)
    const hasActiveEditor = contextKeyService.createKey<boolean>('hasActiveEditor', false)
    const activeEditorLanguageId = contextKeyService.createKey<string>('activeEditorLanguageId', '')
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
        activeEditorLanguageId.set(editor instanceof FileEditorInput ? editor.language : '')
      }),
    )

    // True when a Monaco widget (textarea / find widget / IntelliSense / snippet input)
    // holds DOM focus. Drives ESC routing: when true the global ESC binding bows out
    // so Monaco's own ESC handling (cancel multi-cursor, close find widget, etc.) can
    // fire via natural event bubbling. Written by FileEditor through onDidFocus/BlurEditorWidget.
    contextKeyService.createKey<boolean>('editorFocus', false)

    // True when an xterm.js terminal instance holds DOM focus (panel or editor tab).
    // Written by TerminalInstance via xterm's onFocus/onBlur events.
    contextKeyService.createKey<boolean>('terminalFocus', false)

    // -- group-level editor keys
    const editorPartMultipleEditorGroups = contextKeyService.createKey<boolean>(
      'editorPartMultipleEditorGroups',
      false,
    )
    const editorIsOpen = contextKeyService.createKey<boolean>('editorIsOpen', false)
    const groupEditorsCount = contextKeyService.createKey<number>('groupEditorsCount', 0)
    const activeEditorGroupIndex = contextKeyService.createKey<number>('activeEditorGroupIndex', 0)
    const activeEditorGroupEmpty = contextKeyService.createKey<boolean>(
      'activeEditorGroupEmpty',
      true,
    )
    const activeEditorIsFirstInGroup = contextKeyService.createKey<boolean>(
      'activeEditorIsFirstInGroup',
      false,
    )
    const activeEditorIsLastInGroup = contextKeyService.createKey<boolean>(
      'activeEditorIsLastInGroup',
      false,
    )
    const activeEditorIsDirty = contextKeyService.createKey<boolean>('activeEditorIsDirty', false)

    const syncGroupKeys = () => {
      const active = editorGroupsService.activeGroup
      const allGroups = editorGroupsService.groups
      editorPartMultipleEditorGroups.set(allGroups.length > 1)
      const anyOpen = allGroups.some((g) => g.count > 0)
      editorIsOpen.set(anyOpen)
      groupEditorsCount.set(active.count)
      activeEditorGroupIndex.set(active.index)
      activeEditorGroupEmpty.set(active.count === 0)
      const activeEditor = active.activeEditor
      activeEditorIsFirstInGroup.set(activeEditor !== undefined && active.isFirst(activeEditor))
      activeEditorIsLastInGroup.set(activeEditor !== undefined && active.isLast(activeEditor))
      activeEditorIsDirty.set(activeEditor?.isDirty === true)
    }

    // Subscribe to all group / editor mutations.
    const subscribeActiveGroup = () => {
      const group = editorGroupsService.activeGroup
      const a = this._register(group.onDidChangeModel(syncGroupKeys))
      const b = this._register(group.onDidActiveEditorChange(syncGroupKeys))
      return () => {
        a.dispose()
        b.dispose()
      }
    }
    let unsubscribeActive = subscribeActiveGroup()
    this._register({
      dispose: () => unsubscribeActive(),
    })
    this._register(
      editorGroupsService.onDidActiveGroupChange(() => {
        unsubscribeActive()
        unsubscribeActive = subscribeActiveGroup()
        syncGroupKeys()
      }),
    )
    this._register(editorGroupsService.onDidAddGroup(syncGroupKeys))
    this._register(editorGroupsService.onDidRemoveGroup(syncGroupKeys))
    this._register(editorGroupsService.onDidMoveGroup(syncGroupKeys))
    syncGroupKeys()

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
