/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  openResourcePreview — open the rendered preview for any previewable file
 *  (markdown / html) in a given editor group. Shared by every file list that
 *  offers a hover "Open Preview" button, so they all behave like the SCM row.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroup, IEditorGroupsService, URI } from '@universe-editor/platform'
import { MarkdownPreviewInput } from '../editor/MarkdownPreviewInput.js'
import { HtmlPreviewInput } from '../editor/HtmlPreviewInput.js'
import { openPreviewInGroup } from '../editor/openPreviewInGroup.js'
import { previewLanguageForResource } from './resourcePreviewSupport.js'

/**
 * Open the preview of {@link resource} in {@link group}, pinned. Returns false
 * when the resource has no preview flavor, so callers can stay unconditional.
 * See {@link openPreviewInGroup} for the tab-reuse semantics (a preview of the
 * same file open in another group is focused instead of duplicated).
 */
export function openResourcePreviewInGroup(
  groups: IEditorGroupsService,
  group: IEditorGroup,
  resource: URI,
): boolean {
  const kind = previewLanguageForResource(resource)
  if (kind === 'markdown') {
    openPreviewInGroup(groups, group, new MarkdownPreviewInput(resource))
    return true
  }
  if (kind === 'html') {
    openPreviewInGroup(groups, group, new HtmlPreviewInput(resource))
    return true
  }
  return false
}
