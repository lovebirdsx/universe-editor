/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DiffEditor — React wrapper around Monaco's built-in diff editor widget.
 *
 *  Creates a read-only side-by-side diff view driven by DiffEditorInput. The
 *  Monaco diff instance lives for the component lifetime; swapping inputs
 *  replaces the two models. Models are temporary (not shared via
 *  MonacoModelRegistry) because diff views are transient.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useRef, useState } from 'react'
import {
  IConfigurationService,
  type IDisposable,
  type IEditorInput,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import type { monaco } from './monaco/MonacoLoader.js'
import { MonacoLoader } from './monaco/MonacoLoader.js'
import { languageForResource } from '../files/resourceLanguage.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { DiffEditorRegistry } from '../../services/editor/DiffEditorRegistry.js'
import { EditorViewStateCache } from '../../services/editor/EditorViewStateCache.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { DiffEditorToolbar } from './DiffEditorToolbar.js'
import { diffModelUri } from './diffModelUri.js'
import {
  EDITOR_FONT_FAMILY_DEFAULT,
  type LanguageFontsMap,
  normalizeFontFamily,
  resolveLanguageFonts,
} from '../../services/configuration/fontDefaults.js'
import styles from './DiffEditor.module.css'

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

function getEditorWordWrap(configService: IConfigurationService): 'on' | 'off' {
  return configService.get<boolean>('editor.wordWrap') === true ? 'on' : 'off'
}

function getEditorTheme(configService: IConfigurationService): 'output-light' | 'output-dark' {
  return configService.get<string>('workbench.colorTheme') === 'light'
    ? 'output-light'
    : 'output-dark'
}

export function DiffEditor({ input }: { input: IEditorInput }) {
  const diffInput = input as DiffEditorInput
  const configService = useService(IConfigurationService)
  const group = useContext(EditorGroupContext)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const diffLanguageRef = useRef<string>('plaintext')
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
      theme: getEditorTheme(configService),
      automaticLayout: true,
      ...getEditorFontOptions(configService, diffLanguageRef.current),
      wordWrap: getEditorWordWrap(configService),
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
    return () => {
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
      if (e.affectsConfiguration('editor.wordWrap')) {
        options.wordWrap = getEditorWordWrap(configService)
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
    diffLanguageRef.current = language
    const originalModel = monacoNs.editor.createModel(
      diffInput.originalContent,
      language,
      monacoNs.Uri.parse(diffModelUri(diffInput.originalUri, 'original').toString()),
    )
    const modifiedModel = monacoNs.editor.createModel(
      diffInput.modifiedContent,
      language,
      monacoNs.Uri.parse(diffModelUri(diffInput.originalUri, 'modified').toString()),
    )
    ed.setModel({ original: originalModel, modified: modifiedModel })
    ed.updateOptions(getEditorFontOptions(configService, language))
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel
    DiffEditorRegistry.register(diffInput, ed, group?.id)

    const groupId = group?.id
    const resourceUri = diffInput.resource.toString()
    const fileUri = diffInput.originalUri.toString()

    const flushViewState = () => {
      if (groupId === undefined) return
      const state = diffEditorRef.current?.saveViewState()
      if (state) EditorViewStateCache.save(groupId, resourceUri, state)
      // Share the modified-side cursor under the real file URI so a switch to the
      // plain file editor for the same file lands on it. The original side is old
      // content, so it never drives the shared cursor.
      const pos = diffEditorRef.current?.getModifiedEditor().getPosition()
      if (pos) {
        EditorViewStateCache.saveCursor(groupId, fileUri, {
          lineNumber: pos.lineNumber,
          column: pos.column,
        })
      }
    }

    // Apply a cursor written by another editor (the plain file editor) for the
    // same file to the modified side. Returns whether it moved the cursor.
    const applySharedCursor = (): boolean => {
      if (groupId === undefined) return false
      const sharedCursor = EditorViewStateCache.loadCursor(groupId, fileUri)
      if (!sharedCursor) return false
      const modified = ed.getModifiedEditor()
      const cur = modified.getPosition()
      if (cur && cur.lineNumber === sharedCursor.lineNumber && cur.column === sharedCursor.column) {
        return false
      }
      modified.setPosition(sharedCursor)
      modified.revealLineInCenter(sharedCursor.lineNumber)
      return true
    }

    // Snapshot the persisted view state up front. The cursor/scroll listeners
    // registered below fire synchronously while Monaco initialises the fresh
    // models, overwriting the cache with a top-of-file state before the diff is
    // even computed — so re-loading from the cache inside onDidUpdateDiff would
    // read that bogus state and skip the first-change reveal. Capture the
    // original saved state and re-apply that exact value instead.
    const savedViewState =
      groupId !== undefined
        ? (EditorViewStateCache.load(groupId, resourceUri) as
            | monaco.editor.IDiffEditorViewState
            | undefined)
        : undefined

    if (savedViewState) ed.restoreViewState(savedViewState)

    // Diff layout is computed asynchronously; re-apply the saved scroll position
    // once the first diff lands, or reveal the first change for a freshly-opened
    // diff without a saved state. revealFirstDiff() waits for the diff
    // computation (and the ensuing layout) internally — goToDiff does not — so
    // the view reliably lands on the first change.
    let updateDiffSub: IDisposable | undefined = ed.onDidUpdateDiff(() => {
      updateDiffSub?.dispose()
      updateDiffSub = undefined
      if (savedViewState) ed.restoreViewState(savedViewState)
      // A more recent cursor from the plain file editor wins over the diff's own
      // (stale) viewState and over the default first-change reveal.
      const applied = applySharedCursor()
      if (!savedViewState && !applied) ed.revealFirstDiff()
    })

    const original = ed.getOriginalEditor()
    const modified = ed.getModifiedEditor()
    const subs = [
      original.onDidChangeCursorPosition(flushViewState),
      modified.onDidChangeCursorPosition(flushViewState),
      original.onDidScrollChange(flushViewState),
      modified.onDidScrollChange(flushViewState),
    ]

    return () => {
      flushViewState()
      updateDiffSub?.dispose()
      for (const s of subs) s.dispose()
      DiffEditorRegistry.unregister(diffInput, ed)
      // create-effect cleanup may have already disposed the instance (React runs
      // effect cleanups in declaration order), so guard against a disposed editor.
      diffEditorRef.current?.setModel(null)
      originalModelRef.current = null
      modifiedModelRef.current = null
      originalModel.dispose()
      modifiedModel.dispose()
    }
  }, [monacoNs, diffInput, group, configService])

  // Refresh both sides in place when the input's content changes (e.g. the file
  // is reverted via SCM discard). The diffInput instance is mutated, so the
  // set-model effect above won't re-run — update the live models directly.
  useEffect(() => {
    const disposable = diffInput.onDidChangeContent(() => {
      if (
        originalModelRef.current &&
        originalModelRef.current.getValue() !== diffInput.originalContent
      ) {
        originalModelRef.current.setValue(diffInput.originalContent)
      }
      if (
        modifiedModelRef.current &&
        modifiedModelRef.current.getValue() !== diffInput.modifiedContent
      ) {
        modifiedModelRef.current.setValue(diffInput.modifiedContent)
      }
    })
    return () => disposable.dispose()
  }, [diffInput])

  if (!monacoNs) {
    return (
      <div className={styles['diffEditor']} data-testid="diff-editor">
        <div className={styles['diffEditorLoading']}>正在加载编辑器…</div>
      </div>
    )
  }

  return (
    <div className={styles['diffEditor']} data-testid="diff-editor">
      <div ref={containerRef} className={styles['monacoContainer']} />
      <DiffEditorToolbar />
    </div>
  )
}
