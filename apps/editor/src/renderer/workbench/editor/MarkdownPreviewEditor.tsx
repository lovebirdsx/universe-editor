/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewEditor — renders a MarkdownPreviewInput's source file as
 *  formatted markdown. Tracks the live Monaco model when the source is open
 *  (so edits show immediately) and falls back to reading disk otherwise.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { IEditorInput, IFileService } from '@universe-editor/platform'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import { MonacoModelRegistry } from './monaco/MonacoModelRegistry.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import { useMarkdownSyncScroll } from './useMarkdownSyncScroll.js'
import { useService } from '../useService.js'
import styles from './MarkdownPreviewEditor.module.css'

export function MarkdownPreviewEditor({ input }: { input: IEditorInput }) {
  const fileService = useService(IFileService)
  const sourceUri = (input as MarkdownPreviewInput).sourceUri
  const [content, setContent] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  useMarkdownSyncScroll(rootRef, sourceUri)

  useEffect(() => {
    const model = MonacoModelRegistry.peek(sourceUri)
    if (model) {
      setContent(model.getValue())
      const sub = model.onDidChangeContent(() => setContent(model.getValue()))
      return () => sub.dispose()
    }
    let cancelled = false
    void fileService
      .readFileText(sourceUri)
      .then((text) => {
        if (!cancelled) setContent(text)
      })
      .catch(() => {
        if (!cancelled) setContent('')
      })
    return () => {
      cancelled = true
    }
  }, [fileService, sourceUri])

  return (
    <div ref={rootRef} className={styles['previewRoot']} data-testid="markdown-preview">
      <MarkdownView text={content} className={styles['previewBody'] ?? ''} />
    </div>
  )
}
