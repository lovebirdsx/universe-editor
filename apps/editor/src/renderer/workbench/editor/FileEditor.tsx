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
import { EditorContextMenu } from './EditorContextMenu.js'
import { clampRevealScrollTop } from './previewScrollMap.js'
import { EditorViewStateCache } from '../../services/editor/EditorViewStateCache.js'
import { recordPerfPhase } from '../../services/performance/perfPhases.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { IRecentEditsTracker } from '../../services/ai/RecentEditsTracker.js'
import {
  bridgeInlineSuggestionVisible,
  bridgeInlineEditState,
  bridgeSuggestWidgetVisible,
  bridgeFindWidgetVisible,
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
import './findWordHighlight.css'

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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
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
        automaticLayout: true,
        editContext: true,
        // Monaco's built-in right-click menu is replaced by the MenuRegistry-driven
        // EditorContextMenu (see the contextmenu listener below), so extension
        // `contributes.menus['editor/context']` items actually render.
        contextmenu: false,
        // Semantic highlighting re-colors TextMate's guesses with real type info
        // from the TS language server. It is governed by the
        // `editor.semanticHighlighting.enabled` setting + the active theme's
        // `semanticHighlighting` flag, resolved by the monaco semantic theme bridge
        // (services/themes/monacoSemanticThemeBridge.ts) — no per-editor override.
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
    // "Add Selection to Agent Chat" is registered against MenuId.EditorContext by
    // EditorContextMenuContribution (with `when: editorHasSelection`), so it shows
    // in the MenuRegistry-driven right-click menu wired up below.
    //
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
    // Mirror find-widget visibility so keybindings can yield while it is open
    // (findWordAtCursor's Alt+Down/Alt+Up gate on `!findWidgetVisible`).
    const findWidgetSub = bridgeFindWidgetVisible(ed, contextKeyService)
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
    // Right-click opens the MenuRegistry-driven context menu instead of Monaco's
    // native one (`contextmenu: false` above). clientX/clientY are viewport
    // coordinates, matching the other ContextMenu consumers.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY })
    }
    dropContainer.addEventListener('contextmenu', onContextMenu)
    const hoverGuard = MonacoLoader.trackEditorDispose(ed)
    editorRef.current = ed
    return () => {
      dropContainer.removeEventListener('dragover', armDropIntoEditorOnShift, true)
      dropContainer.removeEventListener('contextmenu', onContextMenu)
      hoverGuard.dispose()
      focusSub.dispose()
      blurSub.dispose()
      textFocusSub.dispose()
      textBlurSub.dispose()
      modelChangeSub.dispose()
      suggestSub.dispose()
      findWidgetSub.dispose()
      inlineSuggestSub.dispose()
      inlineEditSub.dispose()
      columnSelectionSub.dispose()
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
  // Two-phase tab switch: this effect only *schedules* the model swap for the
  // next animation frame, so the click frame paints just the cheap React updates
  // (tab activation, breadcrumbs) and stays responsive. The heavy Monaco work
  // (setModel + layout of a large file) lands one frame later — the editor shows
  // the previous file's content for that one frame, a deliberate trade for
  // instant click feedback on large files. Focus is deferred one further frame:
  // focusing between setModel and Monaco's render forces a wasted full relayout.
  useLayoutEffect(() => {
    fileInputRef.current = fileInput
    if (!monacoNs) return
    let cancelled = false
    let modelRaf: number | undefined
    let focusRaf: number | undefined
    // True once applyModel actually ran: guards the cleanup flush — with the
    // swap deferred a frame, cleanup can run while the editor still holds the
    // *previous* input's model, and flushing then would save that file's
    // viewState under this input's key.
    let modelApplied = false
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
      // Never flush before our own model landed: the editor would still hold
      // the previous input's model and we'd save its viewState under our key.
      if (!modelApplied) return
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
      modelApplied = true
      recordPerfPhase('fileEditor.setModel', () => editorRef.current?.setModel(model))
      // The editor instance is reused across tabs; keep readOnly in sync with
      // the current input (the create-effect only set it for the first input).
      recordPerfPhase('fileEditor.applyOptions', () =>
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
      recordPerfPhase('fileEditor.updateDirty', () => fileInput.updateDirtyFromModel(model))

      // Restore previously saved viewState (cursor, selection, scroll).
      if (groupId !== undefined && editorRef.current) {
        const ed = editorRef.current
        recordPerfPhase('fileEditor.restoreViewState', () => {
          const saved = EditorViewStateCache.load(groupId, resourceUri)
          if (saved) {
            recordPerfPhase('fileEditor.restoreViewState.apply', () =>
              ed.restoreViewState(saved as monaco.editor.ICodeEditorViewState),
            )
          }
          // A one-shot reveal request (e.g. toggling back from a markdown preview
          // that had been scrolled, or entering the preview aligned to the cursor)
          // wins over the saved scroll: put that source line at the top, but clamp so
          // a near-the-end line lands the last line flush at the viewport bottom
          // instead of overshooting into scroll-beyond-last-line padding.
          const revealLine = EditorViewStateCache.takeRevealLine(groupId, resourceUri)
          if (revealLine !== undefined) {
            recordPerfPhase('fileEditor.restoreViewState.reveal', () => {
              const lineTop = ed.getTopForLineNumber(revealLine)
              const lastLine = ed.getModel()?.getLineCount() ?? revealLine
              const contentBottom = ed.getBottomForLineNumber(lastLine)
              const viewportHeight = ed.getLayoutInfo().height
              ed.setScrollTop(
                clampRevealScrollTop({ lineTop, contentBottom, viewportHeight }),
                1 /* ScrollType.Immediate */,
              )
            })
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
              recordPerfPhase('fileEditor.restoreViewState.cursor', () => {
                ed.setPosition(sharedCursor)
                ed.revealPositionInCenter(sharedCursor)
              })
            }
          }
        })
      }

      if (editorRef.current) {
        const ed = editorRef.current
        recordPerfPhase('fileEditor.registerAndFocus', () => {
          registeredEditor = ed
          FileEditorRegistry.register(fileInput, registeredEditor, group?.id)
          // Focus the editor once its model lands — unless the open asked to keep
          // focus elsewhere (single-click preview from a list keeps focus in the
          // originating tree so its selection highlight stays active). Deferred
          // one frame: focusing now, between setModel and Monaco's render, forces
          // the browser to relayout the half-updated DOM (~30ms on large files)
          // that it would relayout again right after.
          if (
            groupsService.activeGroup.activeEditor === fileInput &&
            !groupsService.activeGroup.lastActivationPreservedFocus
          ) {
            focusRaf = requestAnimationFrame(() => {
              if (!cancelled) {
                recordPerfPhase('fileEditor.focus', () =>
                  focusStandaloneEditor(ed, contextKeyService),
                )
              }
            })
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

    // Already-open file: its model is cached and our ref is held — schedule the
    // swap for the next frame so the click frame paints only the cheap tab/
    // breadcrumb updates (two-phase switch; see the effect comment). Double-rAF:
    // a single rAF registered here (before this frame's rendering steps) would
    // still fire before this frame's paint, keeping the heavy swap on the click
    // frame. First open needs a disk read, so it falls back to the async path
    // (a brief loading frame there is unavoidable).
    const cachedModel = fileInput.peekModel()
    if (cachedModel) {
      modelRaf = requestAnimationFrame(() => {
        modelRaf = requestAnimationFrame(() => applyModel(cachedModel))
      })
    } else {
      void fileInput.resolveModel().then(applyModel)
    }

    return () => {
      cancelled = true
      if (modelRaf !== undefined) cancelAnimationFrame(modelRaf)
      if (focusRaf !== undefined) cancelAnimationFrame(focusRaf)
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
    // Deferred a frame for the same reason as the model-swap focus: a sync
    // focus here on the switch frame forces a wasted relayout of a large file.
    const raf = requestAnimationFrame(() => {
      if (editorRef.current) focusStandaloneEditor(editorRef.current, contextKeyService)
    })
    return () => cancelAnimationFrame(raf)
  }, [activeGroup, activeGroupActiveEditor, contextKeyService, fileInput, group])

  if (!monacoNs) {
    return (
      <div className={styles['fileEditorRoot']}>
        <Breadcrumbs input={fileInput} />
        <div className={styles['fileEditor']} data-testid="file-editor">
          <div className={styles['fileEditorLoading']}>
            {localize('editor.loading', 'Loading editor…')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles['fileEditorRoot']}>
      <Breadcrumbs input={fileInput} />
      <div ref={containerRef} className={styles['fileEditor']} data-testid="file-editor" />
      {contextMenu && editorRef.current && (
        <EditorContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          resource={fileInput.resource}
          editor={editorRef.current}
          isReadonly={fileInput.isReadonly}
          commandService={commandService}
          contextKeyService={contextKeyService}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
