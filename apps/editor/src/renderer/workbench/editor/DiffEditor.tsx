/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DiffEditor — React wrapper around Monaco's built-in diff editor widget.
 *
 *  Driven by DiffEditorInput. When the input's modified side is editable (a live
 *  working-tree diff), the right pane shares the file's MonacoModelRegistry model
 *  and is writable; otherwise it stays read-only over snapshot models that on
 *  unmount go to the diffModelCache LRU (services/editor/diffModelCache) so a
 *  reopen skips the createModel + tokenization + diff-compute trio and the
 *  unmount commit never pays a synchronous multi-MB model teardown.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useRef, useState } from 'react'
import {
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  type IDisposable,
  type IEditorInput,
  localize,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import type { monaco } from './monaco/MonacoLoader.js'
import { MonacoLoader } from './monaco/MonacoLoader.js'
import {
  affectsBridgedEditorOption,
  buildBridgedEditorOptions,
} from './monaco/editorOptionsFromConfig.js'
import { languageForResource } from '../files/resourceLanguage.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { DiffEditorRegistry } from '../../services/editor/DiffEditorRegistry.js'
import {
  acquireDiffModels,
  discardDiffModels,
  storeDiffModels,
} from '../../services/editor/diffModelCache.js'
import { applyMinimalTextEdit } from '../../services/editor/minimalModelEdit.js'
import { wireDiffEditorViewState } from './diffEditorViewState.js'
import { syncEditorFocusContext } from '../../services/editor/editorFocus.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { diffModelUri } from './diffModelUri.js'
import {
  EDITOR_FONT_FAMILY_DEFAULT,
  type LanguageFontsMap,
  normalizeFontFamily,
  resolveLanguageFonts,
} from '../../services/configuration/fontDefaults.js'
import styles from './DiffEditor.module.css'

// Per-mount monotonically increasing id, used to qualify this instance's diff
// model URIs so the same input mounted in two groups never collides on one URI.
let nextDiffEditorInstanceId = 0

function getEditorFontOptions(
  configService: IConfigurationService,
  languageId: string,
): { fontFamily: string; fontSize: number } {
  const raw = configService.get<number>('editor.fontSize')
  const globalSize = typeof raw === 'number' ? raw : 14
  const globalFamily = normalizeFontFamily(
    configService.get('editor.fontFamily'),
    EDITOR_FONT_FAMILY_DEFAULT,
  )
  const map = configService.getMerged<LanguageFontsMap>('editor.languageFonts') ?? {}
  return resolveLanguageFonts(globalFamily, globalSize, map, languageId)
}

export function DiffEditor({ input }: { input: IEditorInput }) {
  const diffInput = input as DiffEditorInput
  const configService = useService(IConfigurationService)
  const contextKeyService = useService(IContextKeyService)
  const groupsService = useService(IEditorGroupsService)
  const group = useContext(EditorGroupContext)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const diffLanguageRef = useRef<string>('plaintext')
  const instanceQualifierRef = useRef(`d${nextDiffEditorInstanceId++}`)
  // Whether the currently-mounted modified model is the editable shared model
  // (true) or a read-only snapshot (false). Lets the content-refresh handler skip
  // the modified side when a liveModified flip rebuilds the models.
  const modifiedModelEditableRef = useRef(false)
  const [modifiedEditable, setModifiedEditable] = useState(diffInput.modifiedEditable)
  // Holds the current view-state wiring so the create-effect cleanup can flush it
  // (persist scroll/cursor) *before* it disposes the Monaco instance — otherwise,
  // on unmount, React runs the create-effect cleanup first and disposes the editor,
  // leaving the set-model effect's later flush reading a dead editor (empty state →
  // scroll reset when switching diff↔file and back).
  const viewStateRef = useRef<IDisposable | null>(null)
  const [monacoNs, setMonacoNs] = useState<typeof monaco | null>(null)

  // Load Monaco on demand.
  useEffect(() => {
    let cancelled = false
    void MonacoLoader.ensureInitialized().then((m) => {
      if (!cancelled) setMonacoNs(m)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Create the diff editor instance once Monaco is ready.
  useEffect(() => {
    if (!monacoNs || !containerRef.current) return
    const ed = monacoNs.editor.createDiffEditor(containerRef.current, {
      automaticLayout: true,
      editContext: true,
      // All user-configured editor.* options (incl. wordWrap). Spread first so
      // the bespoke font options below win.
      ...buildBridgedEditorOptions(configService),
      ...getEditorFontOptions(configService, diffLanguageRef.current),
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      unicodeHighlight: {
        nonBasicASCII: false,
        allowedLocales: { _os: true, _vscode: true, 'zh-hans': true, 'zh-hant': true },
      },
    })
    diffEditorRef.current = ed
    const hoverGuard = MonacoLoader.trackEditorDispose(ed)
    return () => {
      // Flush the current view state while the editor is still live (persist
      // scroll/cursor), then dispose. The set-model effect's cleanup runs after
      // this one on unmount and would otherwise flush against a dead editor.
      viewStateRef.current?.dispose()
      viewStateRef.current = null
      hoverGuard.dispose()
      ed.dispose()
      diffEditorRef.current = null
    }
  }, [monacoNs, configService])

  // Apply config changes to the live diff editor.
  useEffect(() => {
    const disposable = configService.onDidChangeConfiguration((e) => {
      const options: monaco.editor.IDiffEditorOptions = {}
      if (
        e.affectsConfiguration('editor.fontSize') ||
        e.affectsConfiguration('editor.fontFamily') ||
        e.affectsConfiguration('editor.languageFonts')
      ) {
        const { fontFamily, fontSize } = getEditorFontOptions(
          configService,
          diffLanguageRef.current,
        )
        options.fontFamily = fontFamily
        options.fontSize = fontSize
      }
      if (affectsBridgedEditorOption(e)) {
        Object.assign(options, buildBridgedEditorOptions(configService))
      }
      if (Object.keys(options).length > 0) diffEditorRef.current?.updateOptions(options)
    })
    return () => disposable.dispose()
  }, [configService])

  // Set the diff model when the input changes, and wire viewState save/restore.
  useEffect(() => {
    if (!monacoNs || !diffEditorRef.current) return
    const ed = diffEditorRef.current

    const language = languageForResource(diffInput.originalUri)
    const modifiedLanguage = languageForResource(diffInput.modifiedUri)
    diffLanguageRef.current = modifiedLanguage
    const qualifier = instanceQualifierRef.current

    let originalModel: monaco.editor.ITextModel
    let modifiedModel: monaco.editor.ITextModel
    if (modifiedEditable) {
      // Editable: the modified side IS the file's shared model. Drop any cached
      // snapshot pair so a flip back to read-only rebuilds fresh snapshot models.
      discardDiffModels(diffInput.id)
      originalModel = monacoNs.editor.createModel(
        diffInput.originalContent,
        language,
        monacoNs.Uri.parse(diffModelUri(diffInput.originalUri, 'original', qualifier).toString()),
      )
      modifiedModel = diffInput.acquireModifiedModel()
    } else {
      // Reopening a diff (Ctrl+Shift+T, or switching back to an unmounted tab)
      // reuses the cached live model pair — skipping two createModel + full
      // tokenization passes plus a fresh diff computation, and sparing the
      // unmount path a synchronous multi-MB model teardown.
      const cached = acquireDiffModels(diffInput.id, {
        originalText: diffInput.originalContent,
        modifiedText: diffInput.modifiedContent,
      })
      originalModel =
        cached?.original ??
        monacoNs.editor.createModel(
          diffInput.originalContent,
          language,
          monacoNs.Uri.parse(diffModelUri(diffInput.originalUri, 'original', qualifier).toString()),
        )
      modifiedModel =
        cached?.modified ??
        monacoNs.editor.createModel(
          diffInput.modifiedContent,
          modifiedLanguage,
          monacoNs.Uri.parse(diffModelUri(diffInput.modifiedUri, 'modified', qualifier).toString()),
        )
    }
    ed.setModel({ original: originalModel, modified: modifiedModel })
    ed.updateOptions({
      readOnly: !modifiedEditable,
      ...getEditorFontOptions(configService, modifiedLanguage),
    })
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel
    modifiedModelEditableRef.current = modifiedEditable
    DiffEditorRegistry.register(diffInput, ed, group?.id)

    // Monaco loads asynchronously, so the group's synchronous focus attempt (in
    // EditorGroupView) ran before this instance existed. Mirror the file editor:
    // once registered, pull focus to the modified side if we're the active editor
    // and the open didn't ask to preserve focus (Space-preview from the SCM list).
    const activeGroup = groupsService.activeGroup
    if (activeGroup.activeEditor === diffInput && !activeGroup.lastActivationPreservedFocus) {
      ed.focus()
      syncEditorFocusContext(contextKeyService)
      queueMicrotask(() => syncEditorFocusContext(contextKeyService))
    }

    const viewState = wireDiffEditorViewState(ed, {
      groupId: group?.id,
      resourceKey: diffInput.resource.toString(),
      sharedCursorUri: diffInput.originalUri.toString(),
    })
    viewStateRef.current = viewState

    return () => {
      // On an input swap (editor stays live) this flushes the outgoing diff's
      // state. On unmount the create-effect cleanup already ran first, flushing
      // and nulling the ref; guard so we don't flush a second time against the
      // now-disposed editor (which would overwrite the good state with an empty one).
      if (viewStateRef.current === viewState) {
        viewState.dispose()
        viewStateRef.current = null
      }
      DiffEditorRegistry.unregister(diffInput, ed)
      // create-effect cleanup may have already disposed the instance (React runs
      // effect cleanups in declaration order), so guard against a disposed editor.
      diffEditorRef.current?.setModel(null)
      originalModelRef.current = null
      modifiedModelRef.current = null
      if (modifiedEditable) {
        // The shared model is owned (refcounted) by this component, not the input —
        // never dispose or cache it. Only the original snapshot dies here. Release
        // our ref AFTER setModel(null) detaches the widget: the input's release is
        // what drops the refcount to zero and disposes the model, and a
        // DiffEditorWidget asserts if its model is disposed while still attached.
        originalModel.dispose()
        diffInput.releaseModifiedModel()
      } else {
        // Hand the pair to the LRU instead of disposing: reopening this diff is
        // then model-free, and the synchronous teardown of two potentially huge
        // TextModels leaves the unmount commit (the cache disposes on eviction).
        storeDiffModels(diffInput.id, originalModel, modifiedModel)
      }
    }
  }, [
    monacoNs,
    diffInput,
    modifiedEditable,
    group,
    configService,
    groupsService,
    contextKeyService,
  ])

  // Refresh both sides in place when the input's content changes (e.g. the file
  // is reverted via SCM discard). The diffInput instance is mutated, so the
  // set-model effect above won't re-run — update the live models directly. A
  // liveModified flip rebuilds the models via that effect instead, so the
  // modified side is skipped here (its ref still points at the old model).
  useEffect(() => {
    setModifiedEditable(diffInput.modifiedEditable)
    const disposable = diffInput.onDidChangeContent(() => {
      setModifiedEditable(diffInput.modifiedEditable)
      const originalModel = originalModelRef.current
      if (originalModel && originalModel.getValue() !== diffInput.originalContent) {
        originalModel.setValue(diffInput.originalContent)
      }
      const modifiedModel = modifiedModelRef.current
      if (!modifiedModel || modifiedModel.isDisposed()) return
      if (diffInput.modifiedEditable !== modifiedModelEditableRef.current) return
      if (diffInput.modifiedEditable) {
        // The shared model holds the user's live edits; only push a clean
        // in-place refresh (e.g. an SCM discard). A minimal edit preserves
        // undo/redo, folding and the cursor — setValue would wipe them.
        if (!diffInput.isDirty && modifiedModel.getValue() !== diffInput.modifiedContent) {
          applyMinimalTextEdit(modifiedModel, diffInput.modifiedContent)
        }
      } else if (modifiedModel.getValue() !== diffInput.modifiedContent) {
        modifiedModel.setValue(diffInput.modifiedContent)
      }
    })
    return () => disposable.dispose()
  }, [diffInput])

  if (!monacoNs) {
    return (
      <div className={styles['diffEditor']} data-testid="diff-editor">
        <div className={styles['diffEditorLoading']}>
          {localize('editor.loading', 'Loading editor…')}
        </div>
      </div>
    )
  }

  return (
    <div className={styles['diffEditor']} data-testid="diff-editor">
      <div ref={containerRef} className={styles['monacoContainer']} />
    </div>
  )
}
