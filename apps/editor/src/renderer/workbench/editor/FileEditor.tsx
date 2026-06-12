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
  markAsSingleton,
  PartId,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import type { monaco } from './monaco/MonacoLoader.js'
import { MonacoLoader } from './monaco/MonacoLoader.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { Breadcrumbs } from './Breadcrumbs.js'
import { EditorViewStateCache } from '../../services/editor/EditorViewStateCache.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { focusStandaloneEditor, syncEditorFocusContext } from '../../services/editor/editorFocus.js'
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

function getEditorWordWrap(configService: IConfigurationService): 'on' | 'off' {
  return configService.get<boolean>('editor.wordWrap') === true ? 'on' : 'off'
}

function getEditorTheme(configService: IConfigurationService): 'output-light' | 'output-dark' {
  return configService.get<string>('workbench.colorTheme') === 'light'
    ? 'output-light'
    : 'output-dark'
}

export function FileEditor({ input }: { input: IEditorInput }) {
  const fileInput = input as FileEditorInput
  const groupsService = useService(IEditorGroupsService)
  const commandService = useService(ICommandService)
  const configService = useService(IConfigurationService)
  const contextKeyService = useService(IContextKeyService)
  const focusStackService = useService(IFocusStackService)
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
    const minimapEnabled = configService.get<boolean>('editor.minimap.enabled') ?? true
    const ed = monacoNs.editor.create(
      containerRef.current,
      {
        theme: getEditorTheme(configService),
        automaticLayout: true,
        editContext: true,
        // 拖放交由编辑区 body 处理(分屏 / 打开外部文件);关掉 Monaco 自带的
        // dropIntoEditor,避免它把拖来的文件路径插进当前文档并抢焦点。
        dropIntoEditor: { enabled: false },
        ...getEditorTypographyOptions(configService, fileInput.language),
        wordWrap: getEditorWordWrap(configService),
        minimap: { enabled: minimapEnabled },
        scrollBeyondLastLine: false,
        tabSize: 2,
        insertSpaces: true,
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
    editorRef.current = ed
    return () => {
      focusSub.dispose()
      blurSub.dispose()
      textFocusSub.dispose()
      textBlurSub.dispose()
      modelChangeSub.dispose()
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
        if (e.affectsConfiguration('editor.wordWrap')) {
          options.wordWrap = getEditorWordWrap(configService)
        }
        if (e.affectsConfiguration('editor.minimap.enabled')) {
          const enabled = configService.get<boolean>('editor.minimap.enabled') ?? true
          options.minimap = { enabled }
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
      editorRef.current?.setModel(model)
      // The editor instance is reused across tabs; keep readOnly in sync with
      // the current input (the create-effect only set it for the first input).
      editorRef.current?.updateOptions({
        readOnly: fileInput.isReadonly,
        ...getEditorTypographyOptions(configService, fileInput.language),
      })

      // Initialise dirty state: covers hot-exit restore (pending dirty content)
      // and shared models that are already dirty in another split.
      fileInput.setDirty(model.getValue() !== fileInput.backupContent)

      // Restore previously saved viewState (cursor, selection, scroll).
      if (groupId !== undefined && editorRef.current) {
        const ed = editorRef.current
        const saved = EditorViewStateCache.load(groupId, resourceUri)
        if (saved) {
          ed.restoreViewState(saved as monaco.editor.ICodeEditorViewState)
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
      }

      if (editorRef.current) {
        registeredEditor = editorRef.current
        FileEditorRegistry.register(fileInput, registeredEditor, group?.id)
        if (groupsService.activeGroup.activeEditor === fileInput) {
          focusStandaloneEditor(editorRef.current, contextKeyService)
        }
        // Keep cache live so toJSON() always captures the latest position.
        cursorSub = editorRef.current.onDidChangeCursorPosition(flushViewState)
        scrollSub = editorRef.current.onDidScrollChange(flushViewState)
      }

      contentSub = model.onDidChangeContent(() => {
        fileInput.setDirty(model.getValue() !== fileInput.backupContent)
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
  }, [monacoNs, contextKeyService, fileInput, groupsService, group, configService])

  useEffect(() => {
    if (activeGroup !== group) return
    if (activeGroupActiveEditor !== fileInput) return
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
