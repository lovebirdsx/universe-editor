/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Routes a resource dropped onto the editor area: folders open in a new window
 *  (one per folder), files open as editors. Pure of React/DOM so it can be unit
 *  tested with stub services.
 *--------------------------------------------------------------------------------------------*/

import type {
  IEditorResolverService,
  IFileService,
  IWindowsService,
  URI,
} from '@universe-editor/platform'

export interface DroppedResourceDeps {
  readonly fileService: Pick<IFileService, 'stat'>
  readonly windowsService: Pick<IWindowsService, 'openWindow'>
  readonly editorResolverService: Pick<IEditorResolverService, 'openEditor'>
}

/**
 * Open a single dropped resource. A folder can't be shown as an editor, so it
 * opens in a new window; anything else (or a URI that can't be statted) opens as
 * an editor.
 */
export async function openDroppedResource(resource: URI, deps: DroppedResourceDeps): Promise<void> {
  let isDirectory = false
  try {
    isDirectory = (await deps.fileService.stat(resource)).isDirectory
  } catch {
    // Non-fs URIs (or missing paths) can't be statted — treat as a file.
  }
  if (isDirectory) {
    await deps.windowsService.openWindow(resource)
  } else {
    await deps.editorResolverService.openEditor(resource)
  }
}
