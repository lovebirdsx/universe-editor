/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DocEditor — renders a built-in guide document (DocEditorInput) as formatted
 *  markdown. Content is bundled at build time (see docRegistry). Relative `.md`
 *  links open as another DocEditorInput via DocLinkContext.
 *
 *  Shares the markdown preview's vimium-style keyboard navigation (link hints /
 *  scroll / find / help) via useMarkdownReaderNav — the doc center is just
 *  another markdown reading surface.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useContext, useRef } from 'react'
import {
  IEditorGroupsService,
  IEditorInput,
  IEditorService,
  localize,
} from '@universe-editor/platform'
import { DocEditorInput } from '../../services/editor/DocEditorInput.js'
import { resolveDoc, isDocId } from '../../services/editor/docRegistry.js'
import { openDocInGroup } from '../../services/editor/openDoc.js'
import { getCurrentLocale } from '../../../shared/i18n/availableLocales.js'
import { useService } from '../useService.js'
import { DocLinkContext, MarkdownView } from '../markdown/MarkdownView.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { useMarkdownReaderNav } from './useMarkdownReaderNav.js'
import { MarkdownReaderOverlays } from './MarkdownReaderOverlays.js'
import { MarkdownPreviewHelp } from './MarkdownPreviewHelp.js'
import styles from './MarkdownPreviewEditor.module.css'
import './markdownFindHighlight.css'

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
  const resolved = resolveDoc(docId)
  const content = resolved?.content ?? `# 文档未找到\n\n文档 "${docId}" 不存在。`
  const isFallback = resolved !== undefined && resolved.locale !== getCurrentLocale()

  const editorService = useService(IEditorService)
  const groupsService = useService(IEditorGroupsService)
  const group = useContext(EditorGroupContext)
  const rootRef = useRef<HTMLDivElement>(null)
  const activeGroup = groupsService.activeGroup
  const isActiveEditor = activeGroup === group && activeGroup.activeEditor === input

  const { find, linkHints, helpVisible, closeHelp } = useMarkdownReaderNav({
    rootRef,
    registryUri: docInput.resource,
    contentSignature: content,
    isActiveEditor,
  })

  const openDocLink = useCallback(
    (href: string, opts?: { toSide?: boolean }) => {
      const { targetDocId, anchor } = resolveDocLink(href, docId)
      if (!isDocId(targetDocId)) return
      const target = new DocEditorInput(targetDocId, anchor)
      // Default: navigate in place — the new doc takes the current tab's slot and
      // the old one closes, so a single tab walks the trail and H/L (or Alt+←/→)
      // steps through history (mirrors the markdown preview). Ctrl/Cmd+click opens
      // an additional tab instead. `group` is null only if this editor isn't
      // mounted in a group (shouldn't happen for a click), so fall back to a plain open.
      if (!opts?.toSide && group && input instanceof DocEditorInput && target.id !== input.id) {
        openDocInGroup(group, target, false)
        return
      }
      void editorService.openEditor(target, { activate: true, pinned: true })
    },
    [docId, editorService, group, input],
  )

  return (
    <DocLinkContext.Provider value={openDocLink}>
      <div ref={rootRef} className={styles['previewRoot']} data-testid="doc-editor" tabIndex={0}>
        <MarkdownReaderOverlays find={find} linkHints={linkHints} rootRef={rootRef} />
        {isFallback && (
          <div className={styles['fallbackNotice']} data-testid="doc-fallback-notice">
            {localize(
              'doc.localeFallback',
              'This page is not yet available in your display language. Showing the 中文 version.',
            )}
          </div>
        )}
        <MarkdownView
          text={content}
          className={styles['previewBody'] ?? ''}
          previewLinks={true}
          {...(docInput.initialAnchor !== undefined
            ? { initialAnchor: docInput.initialAnchor }
            : {})}
        />
        {helpVisible && <MarkdownPreviewHelp onClose={closeHelp} />}
      </div>
    </DocLinkContext.Provider>
  )
}
