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

import { useContext, useEffect, useRef, useState } from 'react'
import type { IDisposable, IEditorInput } from '@universe-editor/platform'
import {
  ICommandService,
  IConfigurationService,
  IEditorGroupsService,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import type { monaco } from './monaco/MonacoLoader.js'
import { MonacoLoader } from './monaco/MonacoLoader.js'
import { MonacoModelRegistry } from './monaco/MonacoModelRegistry.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { EditorViewStateCache } from './EditorViewStateCache.js'
import { FileEditorInput } from './FileEditorInput.js'
import { FileEditorRegistry } from './FileEditorRegistry.js'
import styles from './FileEditor.module.css'

export function FileEditor({ input }: { input: IEditorInput }) {
  const fileInput = input as FileEditorInput
  const groupsService = useService(IEditorGroupsService)
  const commandService = useService(ICommandService)
  const configService = useService(IConfigurationService)
  const group = useContext(EditorGroupContext)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [monacoNs, setMonacoNs] = useState<typeof monaco | null>(null)

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
  useEffect(() => {
    if (!monacoNs || !containerRef.current) return
    const minimapEnabled = configService.get<boolean>('editor.minimap.enabled') ?? true
    const ed = monacoNs.editor.create(containerRef.current, {
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: minimapEnabled },
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      readOnly: false,
      unicodeHighlight: {
        allowedLocales: { _os: true, _vscode: true, 'zh-hans': true, 'zh-hant': true },
      },
    })
    // Hijack Monaco's built-in F1 (StandaloneCommandsQuickAccess) so the
    // global, unified command palette wins regardless of focus.
    ed.addCommand(monacoNs.KeyCode.F1, () => {
      void commandService.executeCommand('workbench.action.showCommands')
    })
    editorRef.current = ed
    return () => {
      ed.dispose()
      editorRef.current = null
    }
  }, [monacoNs, commandService, configService])

  // Apply config changes to the live editor instance.
  useEffect(() => {
    const disposable = configService.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('editor.minimap.enabled')) {
        const enabled = configService.get<boolean>('editor.minimap.enabled') ?? true
        editorRef.current?.updateOptions({ minimap: { enabled } })
      }
    })
    return () => disposable.dispose()
  }, [configService])

  // Wire the active input -> model swap + dirty tracking + viewState save/restore.
  useEffect(() => {
    if (!monacoNs) return
    let cancelled = false
    let contentSub: IDisposable | undefined
    let cursorSub: IDisposable | undefined
    let scrollSub: IDisposable | undefined
    let acquired = false

    const groupId = group?.id
    const resourceUri = fileInput.resource.toString()

    // Flush current viewState into cache — called on cursor/scroll change and on cleanup.
    const flushViewState = () => {
      if (groupId === undefined) return
      const state = editorRef.current?.saveViewState()
      if (state) EditorViewStateCache.save(groupId, resourceUri, state)
    }

    void (async () => {
      const text = await fileInput.resolve().catch(() => '')
      if (cancelled) return
      const model = MonacoModelRegistry.acquire(fileInput.resource, text)
      acquired = true
      // If the model existed already (other split), keep its buffer rather
      // than overwriting from disk. If we just created it, its buffer == text.
      editorRef.current?.setModel(model)

      // Restore previously saved viewState (cursor, selection, scroll).
      if (groupId !== undefined && editorRef.current) {
        const saved = EditorViewStateCache.load(groupId, resourceUri)
        if (saved) {
          editorRef.current.restoreViewState(saved as monaco.editor.ICodeEditorViewState)
        }
      }

      if (editorRef.current) {
        FileEditorRegistry.register(fileInput, editorRef.current)
        if (groupsService.activeGroup.activeEditor === fileInput) {
          editorRef.current.focus()
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
    })()

    return () => {
      cancelled = true
      // Final flush before this input is swapped out or component unmounts.
      flushViewState()
      contentSub?.dispose()
      cursorSub?.dispose()
      scrollSub?.dispose()
      if (editorRef.current) FileEditorRegistry.unregister(fileInput, editorRef.current)
      if (acquired) MonacoModelRegistry.release(fileInput.resource)
    }
  }, [monacoNs, fileInput, groupsService.groups, group, groupsService.activeGroup.activeEditor])

  if (!monacoNs) {
    return (
      <div className={styles['fileEditor']} data-testid="file-editor">
        <div className={styles['fileEditorLoading']}>正在加载编辑器…</div>
      </div>
    )
  }

  return <div ref={containerRef} className={styles['fileEditor']} data-testid="file-editor" />
}
