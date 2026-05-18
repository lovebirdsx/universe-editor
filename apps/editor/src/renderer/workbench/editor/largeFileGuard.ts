/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Large-file guard — Monaco's TextModel struggles with very large buffers, so
 *  we surface a confirm before opening anything above the threshold. Callers
 *  must await the returned boolean; `false` means the user cancelled and the
 *  open should be aborted.
 *--------------------------------------------------------------------------------------------*/

import {
  localize,
  type IDialogService,
  type IFileService,
  type URI,
} from '@universe-editor/platform'

export const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function confirmLargeFile(
  resource: URI,
  fileService: IFileService,
  dialogService: IDialogService,
): Promise<boolean> {
  let size: number
  try {
    const stat = await fileService.stat(resource)
    if (!stat.isFile) return true
    size = stat.size
  } catch {
    // If stat fails the open will likely fail too — let it through and let
    // the editor surface the error itself.
    return true
  }
  if (size <= LARGE_FILE_THRESHOLD) return true
  const result = await dialogService.confirm({
    message: localize('dialog.largeFile.message', 'The file is {size}. Open anyway?', {
      size: formatSize(size),
    }),
    detail: localize(
      'dialog.largeFile.detail',
      'Large files may cause the editor to become unresponsive.',
    ),
    primaryButton: localize('common.open', 'Open'),
    type: 'warning',
  })
  return result.confirmed
}
