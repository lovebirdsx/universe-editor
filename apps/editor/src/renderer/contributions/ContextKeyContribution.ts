/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Sets up the standard ContextKeys consumed by built-in commands and menus:
 *   - isWindows / isMac / isLinux  (platform identity)
 *   - activityBarVisible / sideBarVisible / secondarySideBarVisible / panelVisible  (Part visibility)
 *   - activeEditorId / hasActiveEditor                          (editor state)
 *   - activeEditorLanguageId / activeEditorTypeId                (active editor attributes)
 *   - isInDiffEditor / textCompareEditorVisible                  (active editor is a diff)
 *   - editorFocus                                                (Monaco widget DOM focus)
 *   - editorTextFocus                                            (Monaco text input focus)
 *   - editorColumnSelection                                      (Monaco column-selection mode)
 *   - editorLangId / editorReadonly                              (active editor attributes, monaco parity)
 *   - editorHasDefinitionProvider                               (definition provider for active lang)
 *   - editorHasImplementationProvider                           (impl provider for active lang)
 *   - editorHasReferenceProvider                                (reference provider for active lang)
 *   - editorHasCodeActionsProvider / isInEmbeddedEditor / inReferenceSearchEditor (seeded false)
 *   - editorPartMultipleEditorGroups / editorIsOpen
 *   - groupEditorsCount / activeEditorGroupIndex / activeEditorGroupEmpty
 *   - activeEditorIsFirstInGroup / activeEditorIsLastInGroup / activeEditorIsDirty
 *   - workbenchReady / workbenchRestored                        (lifecycle gates)
 *
 *  The per-view key (`view`) is NOT set here — it lives on per-view scoped
 *  ContextKeyServices owned by `ViewPane` / `ViewContainerHeader` / `SideBar`,
 *  so `MenuId.ViewTitle` actions resolve independently for each view.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  EditorInput,
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
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { MergeEditorInput } from '../services/editor/MergeEditorInput.js'
import { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'

export class ContextKeyContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IHostService hostService: IHostService,
    @ILayoutService layoutService: ILayoutService,
    @IEditorService editorService: IEditorService,
    @IEditorGroupsService editorGroupsService: IEditorGroupsService,
    @ILifecycleService lifecycleService: ILifecycleService,
    @ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
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
    const activeEditorTypeId = contextKeyService.createKey<string>('activeEditorTypeId', '')
    const isInDiffEditor = contextKeyService.createKey<boolean>('isInDiffEditor', false)
    const isInMergeEditor = contextKeyService.createKey<boolean>('isInMergeEditor', false)
    const textCompareEditorVisible = contextKeyService.createKey<boolean>(
      'textCompareEditorVisible',
      false,
    )
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
        activeEditorTypeId.set(editor instanceof EditorInput ? editor.typeId : '')
        const isDiff = editor instanceof DiffEditorInput
        isInDiffEditor.set(isDiff)
        isInMergeEditor.set(editor instanceof MergeEditorInput)
        textCompareEditorVisible.set(isDiff)
      }),
    )

    // -- VSCode-parity editor keys, mirroring monaco's EditorContextKeys. We
    // derive them from the active FileEditorInput rather than monaco's internal
    // context-key service so when-clauses resolve the same whether or not monaco
    // has loaded yet.
    //   editorLangId      — active editor language (monaco: editorLangId)
    //   editorReadonly    — active editor is read-only (monaco: editorReadonly)
    //   editorHasDefinitionProvider — a definition provider is registered for the lang
    //   editorHasImplementationProvider — a provider is registered for the lang
    //   editorHasReferenceProvider — a reference provider is registered for the lang
    //   editorHasCodeActionsProvider    — seeded false; the project has no code-
    //     action provider layer yet, so no data source exists to flip it on.
    //   isInEmbeddedEditor / inReferenceSearchEditor — always false in the main
    //     editor; both are only true inside monaco's embedded/peek widgets, which
    //     maintain their own scoped context-key service.
    const editorLangId = contextKeyService.createKey<string>('editorLangId', '')
    const editorReadonly = contextKeyService.createKey<boolean>('editorReadonly', false)
    const editorHasDefinitionProvider = contextKeyService.createKey<boolean>(
      'editorHasDefinitionProvider',
      false,
    )
    const editorHasImplementationProvider = contextKeyService.createKey<boolean>(
      'editorHasImplementationProvider',
      false,
    )
    const editorHasReferenceProvider = contextKeyService.createKey<boolean>(
      'editorHasReferenceProvider',
      false,
    )
    contextKeyService.createKey<boolean>('editorHasCodeActionsProvider', false)
    contextKeyService.createKey<boolean>('isInEmbeddedEditor', false)
    contextKeyService.createKey<boolean>('inReferenceSearchEditor', false)

    const syncLanguageFeatureKeys = () => {
      const editor = editorService.activeEditor.get()
      const lang = editor instanceof FileEditorInput ? editor.language : ''
      editorLangId.set(lang)
      editorReadonly.set(editor instanceof FileEditorInput ? editor.isReadonly : false)
      editorHasDefinitionProvider.set(
        lang !== '' && languageFeaturesService.hasDefinitionProvider(lang),
      )
      editorHasImplementationProvider.set(
        lang !== '' && languageFeaturesService.hasImplementationProvider(lang),
      )
      editorHasReferenceProvider.set(
        lang !== '' && languageFeaturesService.hasReferenceProvider(lang),
      )
    }
    this._register(
      autorun((reader) => {
        editorService.activeEditor.read(reader)
        syncLanguageFeatureKeys()
      }),
    )
    // Provider registrations land asynchronously (LSP spin-up); re-evaluate when
    // the set of providers changes even if the active editor did not.
    this._register(languageFeaturesService.onDidChangeProviders(syncLanguageFeatureKeys))

    // True when a Monaco widget (textarea / find widget / IntelliSense / snippet input)
    // holds DOM focus. Drives ESC routing: when true the global ESC binding bows out
    // so Monaco's own ESC handling (cancel multi-cursor, close find widget, etc.) can
    // fire via natural event bubbling. Written by FileEditor through onDidFocus/BlurEditorWidget.
    contextKeyService.createKey<boolean>('editorFocus', false)

    // True when the code input area (textarea) holds focus, distinct from
    // editorFocus which covers any monaco widget. Written by FileEditor through
    // onDidFocus/BlurEditorText.
    contextKeyService.createKey<boolean>('editorTextFocus', false)

    // True when the active Monaco editor has editor.columnSelection enabled.
    // Written by FileEditor from Monaco's live editor option.
    contextKeyService.createKey<boolean>('editorColumnSelection', false)

    // True while Monaco's completion (suggest) widget is open. Monaco keeps this
    // on its own scoped context-key service; FileEditor mirrors it here so global
    // and extension keybindings (e.g. smart Enter/Tab) can yield to accept.
    contextKeyService.createKey<boolean>('suggestWidgetVisible', false)

    // True while an inline suggestion (ghost text) is visible. Monaco keeps this
    // on the editor's scoped context-key service; FileEditor mirrors it here so
    // our Tab binding (ai.inlineCompletion.commit) can outrank the editor's
    // indent and accept the suggestion.
    contextKeyService.createKey<boolean>('inlineSuggestionVisible', false)

    // Inline-edit (Next Edit Suggestion) keys, mirrored from Monaco's scoped
    // context-key service by FileEditor's bridgeInlineEditState. They drive the
    // Tab arbitration between jumping to and accepting an inline edit (raw key
    // for visibility is `inlineEditIsVisible`, matching Monaco).
    contextKeyService.createKey<boolean>('inlineEditIsVisible', false)
    contextKeyService.createKey<boolean>('cursorAtInlineEdit', false)
    contextKeyService.createKey<boolean>('tabShouldJumpToInlineEdit', false)
    contextKeyService.createKey<boolean>('tabShouldAcceptInlineEdit', false)

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
