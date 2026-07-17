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
  IContextKeyService,
  IEditorGroupsService,
  type IEditorInput,
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

function getEditorTheme(configService: IConfigurationService): 'output-light' | 'output-dark' {
  return configService.get<string>('workbench.colorTheme') === 'light'
    ? 'output-light'
    : 'output-dark'
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
    const originalModel = monacoNs.editor.createModel(
      diffInput.originalContent,
      language,
      monacoNs.Uri.parse(diffModelUri(diffInput.originalUri, 'original').toString()),
    )
    const modifiedModel = monacoNs.editor.createModel(
      diffInput.modifiedContent,
      modifiedLanguage,
      monacoNs.Uri.parse(diffModelUri(diffInput.modifiedUri, 'modified').toString()),
    )
    ed.setModel({ original: originalModel, modified: modifiedModel })
    ed.updateOptions(getEditorFontOptions(configService, modifiedLanguage))
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel
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

    return () => {
      viewState.dispose()
      DiffEditorRegistry.unregister(diffInput, ed)
      // create-effect cleanup may have already disposed the instance (React runs
      // effect cleanups in declaration order), so guard against a disposed editor.
      diffEditorRef.current?.setModel(null)
      originalModelRef.current = null
      modifiedModelRef.current = null
      originalModel.dispose()
      modifiedModel.dispose()
    }
  }, [monacoNs, diffInput, group, configService, groupsService, contextKeyService])

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
    </div>
  )
}
