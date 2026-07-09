/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewEditor — renders a MarkdownPreviewInput's source file as
 *  formatted markdown. Tracks the live Monaco model when the source is open
 *  (so edits show immediately) and falls back to reading disk otherwise.
 *
 *  The vimium-style keyboard navigation (link hints / scroll / find / help) is
 *  shared with the doc center via useMarkdownReaderNav; this component keeps only
 *  what's preview-specific: Monaco model binding, scroll persistence and the
 *  source↔preview sync scroll.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useRef, useState } from 'react'
import {
  IConfigurationService,
  IEditorGroupsService,
  IEditorInput,
  IFileService,
  markAsSingleton,
  URI,
} from '@universe-editor/platform'
import { EditorGroupContext } from './EditorGroupContext.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import { MonacoModelRegistry } from './monaco/MonacoModelRegistry.js'
import { MonacoLoader } from './monaco/MonacoLoader.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import { useMarkdownSyncScroll } from './useMarkdownSyncScroll.js'
import { useMarkdownReaderNav } from './useMarkdownReaderNav.js'
import { useMarkdownPreviewScrollRestore } from './useMarkdownPreviewScrollRestore.js'
import { MarkdownPreviewHelp } from './MarkdownPreviewHelp.js'
import { MarkdownReaderOverlays } from './MarkdownReaderOverlays.js'
import { useService } from '../useService.js'
import styles from './MarkdownPreviewEditor.module.css'
import './markdownFindHighlight.css'

export function MarkdownPreviewEditor({ input }: { input: IEditorInput }) {
  const fileService = useService(IFileService)
  const groupsService = useService(IEditorGroupsService)
  const configService = useService(IConfigurationService)
  const group = useContext(EditorGroupContext)
  const sourceUri = (input as MarkdownPreviewInput).sourceUri
  const stateKey = sourceUri.toString()
  const [content, setContent] = useState('')
  const [renderFrontmatter, setRenderFrontmatter] = useState(
    () => configService.get<boolean>('markdown.preview.renderYamlFrontmatter') ?? true,
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const activeGroup = groupsService.activeGroup
  const isActiveEditor = activeGroup === group && activeGroup.activeEditor === input
  useMarkdownSyncScroll(rootRef, sourceUri)
  useMarkdownPreviewScrollRestore(rootRef, stateKey)

  useEffect(() => {
    const d = markAsSingleton(
      configService.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('markdown.preview.renderYamlFrontmatter')) {
          setRenderFrontmatter(
            configService.get<boolean>('markdown.preview.renderYamlFrontmatter') ?? true,
          )
        }
      }),
    )
    return () => d.dispose()
  }, [configService])

  const { find, linkHints, helpVisible, closeHelp } = useMarkdownReaderNav({
    rootRef,
    registryUri: sourceUri,
    contentSignature: content,
    isActiveEditor,
  })

  // Bind to the source's shared Monaco model so edits show live. When the source
  // file isn't open in any editor (e.g. a preview reached by clicking a link),
  // there is no shared model — so the Outline view and the markdown language
  // service, which both read symbols from that model, would find nothing. Create
  // (acquire) the model from disk for the preview's lifetime and release it on
  // unmount, so those consumers see the document just like an open source file.
  useEffect(() => {
    let released = false
    let acquired = false
    let sub: { dispose(): void } | undefined

    const bind = (model: ReturnType<typeof MonacoModelRegistry.peek>): void => {
      if (!model || released) return
      setContent(model.getValue())
      sub = model.onDidChangeContent(() => setContent(model.getValue()))
    }

    const existing = MonacoModelRegistry.peek(sourceUri)
    if (existing) {
      bind(existing)
    } else {
      // Read the file and acquire a shared Monaco model for the preview's
      // lifetime. `acquire` needs Monaco loaded (it calls MonacoLoader.get()),
      // which no longer holds by mount time: the workbench now mounts before
      // Monaco finishes loading (workspace-storage hydration was moved off the
      // first-paint path), so gate on ensureInitialized() first — mirroring
      // FileEditor — instead of assuming an earlier editor already forced it.
      void Promise.all([MonacoLoader.ensureInitialized(), fileService.readFileText(sourceUri)])
        .then(([, text]) => {
          if (released) return
          // Another consumer may have opened the source meanwhile; acquire dedups.
          acquired = true
          bind(MonacoModelRegistry.acquire(sourceUri, text))
        })
        .catch(() => {
          if (!released) setContent('')
        })
    }

    return () => {
      released = true
      sub?.dispose()
      if (acquired) MonacoModelRegistry.release(sourceUri)
    }
  }, [fileService, sourceUri])

  return (
    <div
      ref={rootRef}
      className={styles['previewRoot']}
      data-testid="markdown-preview"
      tabIndex={0}
    >
      <MarkdownReaderOverlays find={find} linkHints={linkHints} rootRef={rootRef} />
      <MarkdownView
        text={content}
        className={styles['previewBody'] ?? ''}
        baseUri={URI.joinPath(sourceUri, '..')}
        previewLinks
        frontmatter={renderFrontmatter ? 'table' : 'hidden'}
      />
      {helpVisible && <MarkdownPreviewHelp onClose={closeHelp} />}
    </div>
  )
}
