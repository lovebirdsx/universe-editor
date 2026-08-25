/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  openResourcePreview — open the rendered preview for any previewable file
 *  (markdown / html) in a given editor group. Shared by every file list that
 *  offers a hover "Open Preview" button, so they all behave like the SCM row.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroup, URI } from '@universe-editor/platform'
import { MarkdownPreviewInput } from '../editor/MarkdownPreviewInput.js'
import { HtmlPreviewInput } from '../editor/HtmlPreviewInput.js'
import { openPreviewInGroup } from '../editor/openPreviewInGroup.js'
import { previewLanguageForResource } from './resourcePreviewSupport.js'

/**
 * Open the preview of {@link resource} in {@link group}. Returns false when the
 * resource has no preview flavor, so callers can stay unconditional. See
 * {@link openPreviewInGroup} for the tab-reuse semantics.
 */
export function openResourcePreviewInGroup(
  group: IEditorGroup,
  resource: URI,
  toSide: boolean,
): boolean {
  const kind = previewLanguageForResource(resource)
  if (kind === 'markdown') {
    openPreviewInGroup(group, new MarkdownPreviewInput(resource), toSide)
    return true
  }
  if (kind === 'html') {
    openPreviewInGroup(group, new HtmlPreviewInput(resource), toSide)
    return true
  }
  return false
}
