/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  openResourcePreview — open the rendered preview for any previewable file
 *  (markdown / html) in a given editor group. Shared by every file list that
 *  offers a hover "Open Preview" button, so they all behave like the SCM row.
 *
 *  openResourceForRead is the read-a-file-at-all entry: the rendered preview
 *  when one exists, the editor resolver otherwise. Shared by the agent tool
 *  call card's header button and its context-menu rows.
 *--------------------------------------------------------------------------------------------*/

import type {
  IEditorGroup,
  IEditorGroupsService,
  IEditorResolverService,
  URI,
} from '@universe-editor/platform'
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

/**
 * Open {@link resource} for reading in {@link group}: its rendered preview when
 * the file has one, the file itself otherwise — routed through the resolver so a
 * contributed editor type (image, PDF, a custom editor) still wins over the
 * plain text editor. One body for every "read this file" affordance, so the
 * card header button and the context-menu rows cannot diverge.
 */
export function openResourceForRead(
  groups: IEditorGroupsService,
  group: IEditorGroup,
  resource: URI,
  resolver: IEditorResolverService,
): void {
  if (openResourcePreviewInGroup(groups, group, resource)) return
  void resolver.openEditor(resource, { pinned: true })
}
