/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DiffEditor — React wrapper around Monaco's built-in diff editor widget.
 *
 *  Creates a read-only side-by-side diff view driven by DiffEditorInput. The
 *  Monaco diff instance lives for the component lifetime; swapping inputs
 *  replaces the two models. Models are temporary (not shared via
 *  MonacoModelRegistry) because diff views are transient.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { IConfigurationService, type IEditorInput } from '@universe-editor/platform'
import { useService } from '../useService.js'
import type { monaco } from './monaco/MonacoLoader.js'
import { MonacoLoader } from './monaco/MonacoLoader.js'
import { languageForResource } from '../files/resourceLanguage.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
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

function getEditorTheme(configService: IConfigurationService): 'output-light' | 'output-dark' {
  return configService.get<string>('workbench.colorTheme') === 'light'
    ? 'output-light'
    : 'output-dark'
}

export function DiffEditor({ input }: { input: IEditorInput }) {
  const diffInput = input as DiffEditorInput
  const configService = useService(IConfigurationService)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
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
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      unicodeHighlight: {
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
      if (Object.keys(options).length > 0) diffEditorRef.current?.updateOptions(options)
    })
    return () => disposable.dispose()
  }, [configService])

  // Set the diff model when the input changes.
  useEffect(() => {
    if (!monacoNs || !diffEditorRef.current) return

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
    diffEditorRef.current.setModel({ original: originalModel, modified: modifiedModel })

    return () => {
      originalModel.dispose()
      modifiedModel.dispose()
    }
  }, [monacoNs, diffInput])

  if (!monacoNs) {
    return (
      <div className={styles['diffEditor']} data-testid="diff-editor">
        <div className={styles['diffEditorLoading']}>正在加载编辑器…</div>
      </div>
    )
  }

  return <div ref={containerRef} className={styles['diffEditor']} data-testid="diff-editor" />
}
