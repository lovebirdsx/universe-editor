/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DocEditor — renders a built-in guide document (DocEditorInput) as formatted
 *  markdown. Content is bundled at build time (see docRegistry). Relative `.md`
 *  links open as another DocEditorInput via DocLinkContext.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { IEditorInput, IEditorService } from '@universe-editor/platform'
import { DocEditorInput } from '../../services/editor/DocEditorInput.js'
import { getDocContent, isDocId } from '../../services/editor/docRegistry.js'
import { useService } from '../useService.js'
import { DocLinkContext, MarkdownView } from '../markdown/MarkdownView.js'
import styles from './MarkdownPreviewEditor.module.css'

/** Resolve a relative `.md` href against a base docId directory. */
function resolveRelativePath(base: string, relative: string): string {
  const parts = base ? base.split('/') : []
  for (const segment of relative.split('/')) {
    if (segment === '..') {
      if (parts.length > 0) parts.pop()
    } else if (segment !== '.') {
      parts.push(segment)
    }
  }
  return parts.join('/')
}

/** Parse a relative .md href into a target docId and optional anchor. */
function resolveDocLink(
  href: string,
  currentDocId: string,
): { targetDocId: string; anchor?: string } {
  const hashIdx = href.lastIndexOf('#')
  const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href
  const anchor = hashIdx >= 0 ? href.slice(hashIdx + 1) : undefined
  const docPath = pathPart.endsWith('.md') ? pathPart.slice(0, -3) : pathPart
  const dir = currentDocId.split('/').slice(0, -1).join('/')
  return {
    targetDocId: resolveRelativePath(dir, docPath),
    ...(anchor !== undefined ? { anchor } : {}),
  }
}

export function DocEditor({ input }: { input: IEditorInput }) {
  const docInput = input as DocEditorInput
  const docId = docInput.docId
  const content = getDocContent(docId) ?? `# 文档未找到\n\n文档 "${docId}" 不存在。`

  const editorService = useService(IEditorService)

  const openDocLink = useCallback(
    (href: string) => {
      const { targetDocId, anchor } = resolveDocLink(href, docId)
      if (isDocId(targetDocId)) {
        void editorService.openEditor(new DocEditorInput(targetDocId, anchor))
      }
    },
    [docId, editorService],
  )

  return (
    <DocLinkContext.Provider value={openDocLink}>
      <div className={styles['previewRoot']} data-testid="doc-editor">
        <MarkdownView
          text={content}
          className={styles['previewBody'] ?? ''}
          previewLinks={true}
          {...(docInput.initialAnchor !== undefined
            ? { initialAnchor: docInput.initialAnchor }
            : {})}
        />
      </div>
    </DocLinkContext.Provider>
  )
}
