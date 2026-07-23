/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileEditor — React wrapper around a standalone Monaco editor instance.
 *
 *  The DOM-level Monaco instance lives for the lifetime of the React component;
 *  swapping inputs only calls `editor.setModel(model)`, which means switching
 *  tabs within one EditorGroupView is cheap. The TextModel itself is shared
 *  across groups via MonacoModelRegistry, so two splits of the same file see
 *  each other's edits in real time.
 *
 *  Monaco is loaded on demand (see MonacoLoader). Until the package + workers
 *  resolve, the component renders a lightweight loading placeholder.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { IDisposable, IEditorInput } from '@universe-editor/platform'
import {
  ICommandService,
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  IFocusStackService,
  localize,
  markAsSingleton,
  PartId,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import type { monaco } from './monaco/MonacoLoader.js'
import { MonacoLoader } from './monaco/MonacoLoader.js'
import {
  affectsBridgedEditorOption,
  buildBridgedEditorOptions,
} from './monaco/editorOptionsFromConfig.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { Breadcrumbs } from './Breadcrumbs.js'
import { clampRevealScrollTop } from './previewScrollMap.js'
import { EditorViewStateCache } from '../../services/editor/EditorViewStateCache.js'
import { recordTabSwitchPhase } from '../../services/performance/tabSwitchPerf.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { IRecentEditsTracker } from '../../services/ai/RecentEditsTracker.js'
import {
  bridgeInlineSuggestionVisible,
  bridgeInlineEditState,
  bridgeSuggestWidgetVisible,
  bridgeEditorColumnSelection,
  focusStandaloneEditor,
  syncEditorFocusContext,
} from '../../services/editor/editorFocus.js'
import {
  EDITOR_FONT_FAMILY_DEFAULT,
  EDITOR_FONT_WEIGHT_DEFAULT,
  EDITOR_DISABLE_MONOSPACE_OPTIMIZATIONS_DEFAULT,
  EDITOR_LETTER_SPACING_DEFAULT,
  EDITOR_LINE_HEIGHT_DEFAULT,
  EDITOR_RENDER_LINE_HIGHLIGHT_DEFAULT,
  EDITOR_OCCURRENCES_HIGHLIGHT_DEFAULT,
  type LanguageFontsMap,
  normalizeFontFamily,
  resolveLanguageFonts,
} from '../../services/configuration/fontDefaults.js'
import styles from './FileEditor.module.css'

function getEditorTypographyOptions(
  configService: IConfigurationService,
  languageId: string,
): {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  fontWeight: string
  disableMonospaceOptimizations: boolean
  renderLineHighlight: NonNullable<monaco.editor.IEditorOptions['renderLineHighlight']>
  occurrencesHighlight: NonNullable<monaco.editor.IEditorOptions['occurrencesHighlight']>
} {
  const raw = configService.get<number>('editor.fontSize')
  const globalSize = typeof raw === 'number' ? raw : 14
  const globalFamily = normalizeFontFamily(
    configService.get('editor.fontFamily'),
    EDITOR_FONT_FAMILY_DEFAULT,
  )
  const map = configService.getMerged<LanguageFontsMap>('editor.languageFonts') ?? {}
  const font = resolveLanguageFonts(globalFamily, globalSize, map, languageId)
  return {
    ...font,
    lineHeight: configService.get<number>('editor.lineHeight') ?? EDITOR_LINE_HEIGHT_DEFAULT,
    letterSpacing:
      configService.get<number>('editor.letterSpacing') ?? EDITOR_LETTER_SPACING_DEFAULT,
    fontWeight: configService.get<string>('editor.fontWeight') ?? EDITOR_FONT_WEIGHT_DEFAULT,
    disableMonospaceOptimizations:
      configService.get<boolean>('editor.disableMonospaceOptimizations') ??
      EDITOR_DISABLE_MONOSPACE_OPTIMIZATIONS_DEFAULT,
    renderLineHighlight: (configService.get<string>('editor.renderLineHighlight') ??
      EDITOR_RENDER_LINE_HIGHLIGHT_DEFAULT) as NonNullable<
      monaco.editor.IEditorOptions['renderLineHighlight']
    >,
    occurrencesHighlight: (configService.get<string>('editor.occurrencesHighlight') ??
      EDITOR_OCCURRENCES_HIGHLIGHT_DEFAULT) as NonNullable<
      monaco.editor.IEditorOptions['occurrencesHighlight']
    >,
  }
}

function getEditorTheme(configService: IConfigurationService): 'output-light' | 'output-dark' {
  return configService.get<string>('workbench.colorTheme') === 'light'
    ? 'output-light'
    : 'output-dark'
}

// Monaco's built-in drop-into-editor stays OFF at rest for every language: a
// plain drag keeps the original behaviour (the editor-area body opens the
// dropped file). It is armed on the fly — only while the user holds Shift over a
// markdown model — by the capture-phase dragover listener installed in the create
// effect, matching VSCode's "hold Shift to insert as link" gesture. Monaco reads
// `dropIntoEditor.enabled` live on each dragover/drop, so toggling it just before
// its own bubble-phase listener runs is enough. `showDropSelector: 'never'`
// applies our provider's edit directly without the drop-kind chooser widget.
const DROP_INTO_EDITOR_OFF: NonNullable<monaco.editor.IEditorOptions['dropIntoEditor']> = {
  enabled: false,
}
const DROP_INTO_EDITOR_LINK: NonNullable<monaco.editor.IEditorOptions['dropIntoEditor']> = {
  enabled: true,
  showDropSelector: 'never',
}

export function FileEditor({ input }: { input: IEditorInput }) {
  const fileInput = input as FileEditorInput
  const groupsService = useService(IEditorGroupsService)
  const commandService = useService(ICommandService)
  const configService = useService(IConfigurationService)
  const contextKeyService = useService(IContextKeyService)
  const focusStackService = useService(IFocusStackService)
  const recentEditsTracker = useService(IRecentEditsTracker)
  const group = useContext(EditorGroupContext)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // Latest input, read by long-lived editor callbacks (e.g. the blur handler)
  // that must not be recreated on tab switch. Kept in sync by the model-swap
  // effect below so switching tabs stays a cheap setModel — no editor rebuild.
  const fileInputRef = useRef(fileInput)
  const [monacoNs, setMonacoNs] = useState<typeof monaco | null>(null)
  const activeGroup = groupsService.activeGroup
  const activeGroupActiveEditor = activeGroup.activeEditor

  useEffect(() => {
    let cancelled = false
    void MonacoLoader.ensureInitialized().then((m) => {
      if (!cancelled) setMonacoNs(m)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Create the standalone editor once monaco is ready; never recreate on input change.
  useLayoutEffect(() => {
    if (!monacoNs || !containerRef.current) return
    const ed = monacoNs.editor.create(
      containerRef.current,
      {
        theme: getEditorTheme(configService),
        automaticLayout: true,
        editContext: true,
        // Semantic highlighting re-colors TextMate's guesses with real type info
        // from the TS language server (e.g. an uppercase property no longer looks
        // like a type). Standalone themes hardcode semanticHighlighting=false, so
        // enable it explicitly here — this editor option overrides the theme flag.
        'semanticHighlighting.enabled': true,
        // 拖放默认交由编辑区 body 处理(分屏 / 打开外部文件),各语言一律保持关闭。
        // 仅当用户按住 Shift 拖到 markdown 文本区时,由下方 capture 阶段的 dragover
        // 监听临时打开,让拖入的文件/图片成为链接(见 MarkdownDropContribution)。
        dropIntoEditor: DROP_INTO_EDITOR_OFF,
        // All user-configured editor.* options (minimap, wordWrap, tabSize,
        // insertSpaces, cursor*, renderWhitespace, …). Spread first so the
        // bespoke typography options below win.
        ...buildBridgedEditorOptions(configService),
        ...getEditorTypographyOptions(configService, fileInput.language),
        readOnly: fileInput.isReadonly,
        unicodeHighlight: {
          nonBasicASCII: false,
          allowedLocales: { _os: true, _vscode: true, 'zh-hans': true, 'zh-hant': true },
        },
      },
      MonacoLoader.getOverrideServices(),
    )
    // Hijack Monaco's built-in F1 (StandaloneCommandsQuickAccess) so the
    // global, unified command palette wins regardless of focus.
    ed.addCommand(monacoNs.KeyCode.F1, () => {
      void commandService.executeCommand('workbench.action.showCommands')
    })
    // Surface "Add Selection to Agent Chat" in Monaco's native context menu.
    // Monaco's right-click menu reads its own action registry, not our
    // MenuRegistry, so we mirror the command as an editor action here. Gated on a
    // non-empty selection so it only shows when there's something to attach.
    const addSelectionAction = ed.addAction({
      id: 'workbench.action.agent.addSelectionToChat',
      label: localize('action.agent.addSelectionToChat', 'Add Selection to Agent Chat'),
      // Mirror the global `ctrl+k ctrl+l` chord (agentContextActions.ts) so Monaco's
      // native context menu renders the shortcut next to the item. Monaco reads the
      // hint from its own keybinding service, which doesn't know our global binding.
      keybindings: [
        monacoNs.KeyMod.chord(
          monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyK,
          monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyL,
        ),
      ],
      contextMenuGroupId: '1_agent',
      contextMenuOrder: 1,
      precondition: 'editorHasSelection',
      run: () => {
        void commandService.executeCommand('workbench.action.agent.addSelectionToChat')
      },
    })
    // Bridge Monaco widget focus → `editorFocus` contextKey, so the global ESC
    // binding (FocusActiveEditorGroupAction) bows out while Monaco has focus and
    // Monaco's own ESC handling (cancel multi-cursor, close find widget, dismiss
    // IntelliSense) can fire via event bubbling.
    const focusSub = ed.onDidFocusEditorWidget(() => {
      contextKeyService.set('editorFocus', true)
    })
    const blurSub = ed.onDidBlurEditorWidget(() => {
      queueMicrotask(() => {
        syncEditorFocusContext(contextKeyService)
        // Chromium's default behavior after a click on a non-focusable element
        // (e.g. a tab div) moves focus to document.body. Reclaim it only if the
        // user hasn't moved focus elsewhere — focusStack.getTop() is the source
        // of truth because FocusTracker observed any real navigation already.
        if (document.activeElement !== document.body) return
        if (group === null) return
        if (groupsService.activeGroup !== group) return
        if (groupsService.activeGroup.activeEditor !== fileInputRef.current) return
        const top = focusStackService.getTop()
        if (top && top.partId !== PartId.EditorArea) return
        if (top && top.groupId !== undefined && top.groupId !== group.id) return
        ed.focus()
        syncEditorFocusContext(contextKeyService)
      })
    })
    // Bridge: `editorTextFocus` tracks focus on the code input area itself (the
    // textarea), distinct from `editorFocus` which is true for any monaco widget
    // (find box, IntelliSense). Mirrors VSCode's EditorContextKeys split.
    const textFocusSub = ed.onDidFocusEditorText(() => {
      contextKeyService.set('editorTextFocus', true)
    })
    const textBlurSub = ed.onDidBlurEditorText(() => {
      contextKeyService.set('editorTextFocus', false)
    })
    const modelChangeSub = ed.onDidChangeModel(() => {
      const lang = ed.getModel()?.getLanguageId()
      ed.updateOptions({
        quickSuggestions: {
          other: true,
          comments: false,
          strings: lang === 'json' || lang === 'jsonc',
        },
      })
    })
    // Mirror Monaco's suggest-widget visibility onto the global `suggestWidgetVisible`
    // context key so extension keybindings (smart Enter/Tab) yield to completion
    // accept while the widget is open. Monaco keeps this key only on its own scoped
    // context-key service; the global handler can't see it otherwise.
    const suggestSub = bridgeSuggestWidgetVisible(ed, contextKeyService)
    // Mirror inline-suggestion (ghost text) visibility so our Tab binding can
    // accept it; Monaco's own editContext Tab dispatch can't be relied on.
    const inlineSuggestSub = bridgeInlineSuggestionVisible(ed, contextKeyService)
    // Mirror inline-edit (Next Edit Suggestion) state for the Tab jump/accept
    // arbitration, for the same editContext reason.
    const inlineEditSub = bridgeInlineEditState(ed, contextKeyService)
    const columnSelectionSub = bridgeEditorColumnSelection(ed, monacoNs, contextKeyService)
    // Arm Monaco's drop-into-editor only while Shift is held over a markdown model,
    // so a plain drag still opens the dropped file (handled by the editor body) and
    // Shift+drag inserts a link instead — VSCode's gesture. Capture phase runs
    // before Monaco's own bubble-phase dragover/drop listeners, which read
    // `dropIntoEditor.enabled` live, so the flag is in place by the time they fire.
    // dragover retriggers continuously, so the last one before a drop always sets
    // the correct state; no reset is needed (a later dragover or model swap
    // restores the OFF baseline).
    const dropContainer = ed.getContainerDomNode()
    const armDropIntoEditorOnShift = (e: DragEvent) => {
      const isMarkdown = ed.getModel()?.getLanguageId() === 'markdown'
      ed.updateOptions({
        dropIntoEditor: e.shiftKey && isMarkdown ? DROP_INTO_EDITOR_LINK : DROP_INTO_EDITOR_OFF,
      })
    }
    dropContainer.addEventListener('dragover', armDropIntoEditorOnShift, true)
    editorRef.current = ed
    return () => {
      dropContainer.removeEventListener('dragover', armDropIntoEditorOnShift, true)
      focusSub.dispose()
      blurSub.dispose()
      textFocusSub.dispose()
      textBlurSub.dispose()
      modelChangeSub.dispose()
      suggestSub.dispose()
      inlineSuggestSub.dispose()
      inlineEditSub.dispose()
      columnSelectionSub.dispose()
      addSelectionAction.dispose()
      ed.dispose()
      queueMicrotask(() => syncEditorFocusContext(contextKeyService))
      editorRef.current = null
    }
    // Create the editor once and keep it for the component's lifetime — never
    // recreate on input or active-group change. The active input is read lazily
    // via `fileInputRef` (blur handler) and the model-swap effect handles input
    // changes with setModel, so neither is a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monacoNs, commandService, configService, contextKeyService, focusStackService, group])

  // Apply config changes to the live editor instance.
  useEffect(() => {
    const disposable = markAsSingleton(
      configService.onDidChangeConfiguration((e) => {
        const options: monaco.editor.IEditorOptions = {}
        if (
          e.affectsConfiguration('editor.fontSize') ||
          e.affectsConfiguration('editor.fontFamily') ||
          e.affectsConfiguration('editor.languageFonts') ||
          e.affectsConfiguration('editor.lineHeight') ||
          e.affectsConfiguration('editor.letterSpacing') ||
          e.affectsConfiguration('editor.fontWeight') ||
          e.affectsConfiguration('editor.disableMonospaceOptimizations') ||
          e.affectsConfiguration('editor.renderLineHighlight') ||
          e.affectsConfiguration('editor.occurrencesHighlight')
        ) {
          const {
            fontFamily,
            fontSize,
            lineHeight,
            letterSpacing,
            fontWeight,
            disableMonospaceOptimizations,
            renderLineHighlight,
            occurrencesHighlight,
          } = getEditorTypographyOptions(configService, fileInputRef.current.language)
          options.fontFamily = fontFamily
          options.fontSize = fontSize
          options.lineHeight = lineHeight
          options.letterSpacing = letterSpacing
          options.fontWeight = fontWeight
          options.disableMonospaceOptimizations = disableMonospaceOptimizations
          options.renderLineHighlight = renderLineHighlight
          options.occurrencesHighlight = occurrencesHighlight
        }
        // Bridge every other user-configured editor.* option (minimap,
        // wordWrap, tabSize, insertSpaces, cursor*, renderWhitespace, …).
        // Applied after the bespoke typography keys above; the bridge excludes
        // those keys so no conflict.
        if (affectsBridgedEditorOption(e)) {
          Object.assign(options, buildBridgedEditorOptions(configService))
        }
        if (Object.keys(options).length > 0) editorRef.current?.updateOptions(options)
      }),
    )
    return () => disposable.dispose()
  }, [configService])

  // Wire the active input -> model swap + dirty tracking + viewState save/restore.
  // useLayoutEffect (not useEffect) so that switching back to an already-open file
  // swaps the model *before* the browser paints — mirroring VSCode, which avoids a
  // one-frame flash of the previous file's content on every tab switch.
  useLayoutEffect(() => {
    fileInputRef.current = fileInput
    if (!monacoNs) return
    let cancelled = false
    let contentSub: IDisposable | undefined
    let cursorSub: IDisposable | undefined
    let scrollSub: IDisposable | undefined
    // Capture the editor we register so cleanup can unregister it regardless of
    // editorRef.current — the create-effect cleanup may have already nulled the
    // ref (it runs first on rebuild/unmount), which would otherwise leave a dead
    // registration behind and stick the Outline on the previous file.
    let registeredEditor: monaco.editor.IStandaloneCodeEditor | undefined

    const groupId = group?.id
    const resourceUri = fileInput.resource.toString()

    // Flush current viewState into cache — called on cursor/scroll change and on cleanup.
    const flushViewState = () => {
      if (groupId === undefined) return
      const ed = editorRef.current
      const state = ed?.saveViewState()
      if (state) EditorViewStateCache.save(groupId, resourceUri, state)
      const pos = ed?.getPosition()
      if (pos) {
        EditorViewStateCache.saveCursor(groupId, resourceUri, {
          lineNumber: pos.lineNumber,
          column: pos.column,
        })
      }
    }

    const applyModel = (model: monaco.editor.ITextModel) => {
      if (cancelled) return
      recordTabSwitchPhase('fileEditor.setModel', () => editorRef.current?.setModel(model))
      // The editor instance is reused across tabs; keep readOnly in sync with
      // the current input (the create-effect only set it for the first input).
      recordTabSwitchPhase('fileEditor.applyOptions', () =>
        editorRef.current?.updateOptions({
          readOnly: fileInput.isReadonly,
          // Reset drop-into-editor to the OFF baseline on every model swap; the
          // Shift-held dragover listener re-arms it per drag when appropriate.
          dropIntoEditor: DROP_INTO_EDITOR_OFF,
          ...getEditorTypographyOptions(configService, fileInput.language),
        }),
      )

      // Initialise dirty state: covers hot-exit restore (pending dirty content)
      // and shared models that are already dirty in another split.
      recordTabSwitchPhase('fileEditor.updateDirty', () => fileInput.updateDirtyFromModel(model))

      // Restore previously saved viewState (cursor, selection, scroll).
      if (groupId !== undefined && editorRef.current) {
        const ed = editorRef.current
        recordTabSwitchPhase('fileEditor.restoreViewState', () => {
          const saved = EditorViewStateCache.load(groupId, resourceUri)
          if (saved) {
            ed.restoreViewState(saved as monaco.editor.ICodeEditorViewState)
          }
          // A one-shot reveal request (e.g. toggling back from a markdown preview
          // that had been scrolled, or entering the preview aligned to the cursor)
          // wins over the saved scroll: put that source line at the top, but clamp so
          // a near-the-end line lands the last line flush at the viewport bottom
          // instead of overshooting into scroll-beyond-last-line padding.
          const revealLine = EditorViewStateCache.takeRevealLine(groupId, resourceUri)
          if (revealLine !== undefined) {
            const lineTop = ed.getTopForLineNumber(revealLine)
            const lastLine = ed.getModel()?.getLineCount() ?? revealLine
            const contentBottom = ed.getBottomForLineNumber(lastLine)
            const viewportHeight = ed.getLayoutInfo().height
            ed.setScrollTop(
              clampRevealScrollTop({ lineTop, contentBottom, viewportHeight }),
              1 /* ScrollType.Immediate */,
            )
          }
          // A more recent cursor written by the diff editor for the same file wins
          // over our own (possibly stale) viewState, so switching diff -> file
          // lands on the position last seen in the diff's modified side.
          const sharedCursor = EditorViewStateCache.loadCursor(groupId, resourceUri)
          if (sharedCursor) {
            const cur = ed.getPosition()
            if (
              !cur ||
              cur.lineNumber !== sharedCursor.lineNumber ||
              cur.column !== sharedCursor.column
            ) {
              ed.setPosition(sharedCursor)
              ed.revealPositionInCenter(sharedCursor)
            }
          }
        })
      }

      if (editorRef.current) {
        const ed = editorRef.current
        recordTabSwitchPhase('fileEditor.registerAndFocus', () => {
          registeredEditor = ed
          FileEditorRegistry.register(fileInput, registeredEditor, group?.id)
          // Focus the editor once its model lands — unless the open asked to keep
          // focus elsewhere (single-click preview from a list keeps focus in the
          // originating tree so its selection highlight stays active).
          if (
            groupsService.activeGroup.activeEditor === fileInput &&
            !groupsService.activeGroup.lastActivationPreservedFocus
          ) {
            focusStandaloneEditor(ed, contextKeyService)
          }
          // Keep cache live so toJSON() always captures the latest position.
          cursorSub = ed.onDidChangeCursorPosition(flushViewState)
          scrollSub = ed.onDidScrollChange(flushViewState)
        })
      }

      contentSub = model.onDidChangeContent((e) => {
        fileInput.updateDirtyFromModel(model)
        // Feed the user's edits to the Next Edit Suggestion history.
        recentEditsTracker.record(resourceUri, e.changes)
        // First edit upgrades a preview tab to pinned. pinEditor is a no-op
        // when the input isn't currently the group's preview slot.
        for (const g of groupsService.groups) {
          if (g.previewEditor === fileInput) {
            g.pinEditor(fileInput)
            break
          }
        }
      })
    }

    // Already-open file: its model is cached and our ref is held — swap it
    // synchronously, before paint. First open needs a disk read, so it falls
    // back to the async path (a brief loading frame here is unavoidable).
    const cachedModel = fileInput.peekModel()
    if (cachedModel) {
      applyModel(cachedModel)
    } else {
      void fileInput.resolveModel().then(applyModel)
    }

    return () => {
      cancelled = true
      // Final flush before this input is swapped out or component unmounts.
      flushViewState()
      contentSub?.dispose()
      cursorSub?.dispose()
      scrollSub?.dispose()
      if (registeredEditor) FileEditorRegistry.unregister(fileInput, registeredEditor)
    }
  }, [
    monacoNs,
    contextKeyService,
    fileInput,
    groupsService,
    group,
    configService,
    recentEditsTracker,
  ])

  useEffect(() => {
    if (activeGroup !== group) return
    if (activeGroupActiveEditor !== fileInput) return
    if (activeGroup.lastActivationPreservedFocus) return
    if (editorRef.current) focusStandaloneEditor(editorRef.current, contextKeyService)
  }, [activeGroup, activeGroupActiveEditor, contextKeyService, fileInput, group])

  if (!monacoNs) {
    return (
      <div className={styles['fileEditorRoot']}>
        <Breadcrumbs input={fileInput} />
        <div className={styles['fileEditor']} data-testid="file-editor">
          <div className={styles['fileEditorLoading']}>正在加载编辑器…</div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles['fileEditorRoot']}>
      <Breadcrumbs input={fileInput} />
      <div ref={containerRef} className={styles['fileEditor']} data-testid="file-editor" />
    </div>
  )
}
