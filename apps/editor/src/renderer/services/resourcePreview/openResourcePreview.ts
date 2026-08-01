/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  openResourcePreview — open the rendered preview for any previewable file
 *  (markdown / html) in a given editor group. Shared by every file list that
 *  offers a hover "Open Preview" button, so they all behave like the SCM row:
 *  navigating between previews reuses the current preview tab (VSCode-style
 *  single-tab trail), anything else just opens a new pinned preview tab.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroup, URI } from '@universe-editor/platform'
import { MarkdownPreviewInput } from '../editor/MarkdownPreviewInput.js'
import { HtmlPreviewInput } from '../editor/HtmlPreviewInput.js'
import { openMarkdownPreviewInGroup } from '../editor/openMarkdownPreview.js'
import { previewLanguageForResource } from './resourcePreviewSupport.js'

/**
 * Open the preview of {@link resource} in {@link group}. Returns false when the
 * resource has no preview flavor, so callers can stay unconditional. See
 * {@link openMarkdownPreviewInGroup} for the tab-reuse semantics; the html
 * branch mirrors them for HtmlPreviewInput.
 */
export function openResourcePreviewInGroup(
  group: IEditorGroup,
  resource: URI,
  toSide: boolean,
): boolean {
  const kind = previewLanguageForResource(resource)
  if (kind === 'markdown') {
    openMarkdownPreviewInGroup(group, new MarkdownPreviewInput(resource), toSide)
    return true
  }
  if (kind === 'html') {
    const preview = new HtmlPreviewInput(resource)
    if (!toSide) {
      const current = group.activeEditor
      if (current instanceof HtmlPreviewInput && current.id !== preview.id) {
        const index = group.indexOf(current)
        group.openEditor(preview, { activate: true, pinned: true, index })
        group.closeEditor(current)
        return true
      }
    }
    group.openEditor(preview, { activate: true, pinned: true })
    return true
  }
  return false
}
