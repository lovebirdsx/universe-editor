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
import styles from './DiffEditor.module.css'

function getEditorFontSize(configService: IConfigurationService): number {
  const fontSize = configService.get<number>('editor.fontSize')
  return typeof fontSize === 'number' ? fontSize : 14
}

function getEditorFontFamily(configService: IConfigurationService): string {
  const raw = configService.get<string>('editor.fontFamily')
  return typeof raw === 'string' && raw.trim() ? raw : "'Fira Code', Consolas, monospace"
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
      fontSize: getEditorFontSize(configService),
      fontFamily: getEditorFontFamily(configService),
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
      if (e.affectsConfiguration('editor.fontSize')) {
        options.fontSize = getEditorFontSize(configService)
      }
      if (e.affectsConfiguration('editor.fontFamily')) {
        options.fontFamily = getEditorFontFamily(configService)
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
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel
    DiffEditorRegistry.register(diffInput, ed, group?.id)

    const groupId = group?.id
    const resourceUri = diffInput.resource.toString()

    const flushViewState = () => {
      if (groupId === undefined) return
      const state = diffEditorRef.current?.saveViewState()
      if (state) EditorViewStateCache.save(groupId, resourceUri, state)
    }

    const restoreViewState = (): boolean => {
      if (groupId === undefined) return false
      const saved = EditorViewStateCache.load(groupId, resourceUri)
      if (!saved) return false
      diffEditorRef.current?.restoreViewState(saved as monaco.editor.IDiffEditorViewState)
      return true
    }

    let didRestoreViewState = restoreViewState()
    // Diff layout is computed asynchronously; re-apply once after the first
    // computation so scroll position lands on the right line, or reveal the
    // first change for newly-opened diff editors without a saved state.
    let updateDiffSub: IDisposable | undefined = ed.onDidUpdateDiff(() => {
      updateDiffSub?.dispose()
      updateDiffSub = undefined
      didRestoreViewState = restoreViewState() || didRestoreViewState
      if (!didRestoreViewState) ed.goToDiff('next')
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
  }, [monacoNs, diffInput, group])

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
