/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileEditor — React wrapper around a standalone Monaco editor instance.
 *
 *  The DOM-level Monaco instance lives for the lifetime of the React component;
 *  swapping inputs only calls `editor.setModel(model)`, which means switching
 *  tabs within one EditorGroupView is cheap. The TextModel itself is shared
 *  across groups via MonacoModelRegistry, so two splits of the same file see
 *  each other's edits in real time.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import type { IDisposable, IEditorInput } from '@universe-editor/platform'
import { monaco } from './monaco/MonacoLoader.js'
import { MonacoModelRegistry } from './monaco/MonacoModelRegistry.js'
import { FileEditorInput } from './FileEditorInput.js'
import { FileEditorRegistry } from './FileEditorRegistry.js'
import styles from './FileEditor.module.css'

export function FileEditor({ input }: { input: IEditorInput }) {
  const fileInput = input as FileEditorInput
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  // Create the standalone editor once; never recreate on input change.
  useEffect(() => {
    if (!containerRef.current) return
    const ed = monaco.editor.create(containerRef.current, {
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      readOnly: false,
    })
    editorRef.current = ed
    return () => {
      ed.dispose()
      editorRef.current = null
    }
  }, [])

  // Wire the active input -> model swap + dirty tracking.
  useEffect(() => {
    let cancelled = false
    let contentSub: IDisposable | undefined
    let acquired = false

    void (async () => {
      const text = await fileInput.resolve().catch(() => '')
      if (cancelled) return
      const model = MonacoModelRegistry.acquire(fileInput.resource, text)
      acquired = true
      // If the model existed already (other split), keep its buffer rather
      // than overwriting from disk. If we just created it, its buffer == text.
      editorRef.current?.setModel(model)
      if (editorRef.current) FileEditorRegistry.register(fileInput, editorRef.current)
      contentSub = model.onDidChangeContent(() => {
        fileInput.setDirty(model.getValue() !== fileInput.backupContent)
      })
    })()

    return () => {
      cancelled = true
      contentSub?.dispose()
      if (editorRef.current) FileEditorRegistry.unregister(fileInput, editorRef.current)
      if (acquired) MonacoModelRegistry.release(fileInput.resource)
    }
  }, [fileInput])

  return <div ref={containerRef} className={styles['fileEditor']} />
}
