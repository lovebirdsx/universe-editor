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
  EditorInput,
  IEditorGroup,
  IEditorGroupsService,
  IEditorResolverService,
  URI,
} from '@universe-editor/platform'
import { MarkdownPreviewInput } from '../editor/MarkdownPreviewInput.js'
import { HtmlPreviewInput } from '../editor/HtmlPreviewInput.js'
import { openPreviewInGroup } from '../editor/openPreviewInGroup.js'
import type { IWindowFocusService } from '../windows/windowFocusService.js'
import { previewLanguageForResource } from './resourcePreviewSupport.js'

/** A previewable resource's tab id + factory, for target-aware opens that must
 *  reuse a globally unique preview instead of instantiating a second one. */
export function resourcePreviewDescriptor(
  resource: URI,
): { readonly id: string; readonly create: () => EditorInput } | undefined {
  const kind = previewLanguageForResource(resource)
  if (kind === 'markdown') {
    return {
      id: MarkdownPreviewInput.idFor(resource),
      create: () => new MarkdownPreviewInput(resource),
    }
  }
  if (kind === 'html') {
    return { id: HtmlPreviewInput.idFor(resource), create: () => new HtmlPreviewInput(resource) }
  }
  return undefined
}

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
  windowFocus?: IWindowFocusService,
): boolean {
  const kind = previewLanguageForResource(resource)
  const focusOpts = windowFocus ? { windowFocus } : {}
  if (kind === 'markdown') {
    openPreviewInGroup(groups, group, new MarkdownPreviewInput(resource), focusOpts)
    return true
  }
  if (kind === 'html') {
    openPreviewInGroup(groups, group, new HtmlPreviewInput(resource), focusOpts)
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
  windowFocus?: IWindowFocusService,
): void {
  if (openResourcePreviewInGroup(groups, group, resource, windowFocus)) return
  void resolver.openEditor(resource, { pinned: true })
}
