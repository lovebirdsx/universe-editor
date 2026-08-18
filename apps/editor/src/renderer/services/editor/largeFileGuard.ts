/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pre-open guard for file:// resources. Monaco's TextModel struggles with very
 *  large buffers, so we surface a confirm before opening anything above the
 *  threshold — but only for files that will actually open in the text editor.
 *  Files routed to a dedicated editor (image/PDF/Excel) pass through untouched,
 *  and binary files get a "binary or unsupported encoding" confirm instead of a
 *  file-size warning (mirrors VSCode's two distinct FILE_TOO_LARGE / FILE_IS_BINARY
 *  paths). Callers must await the returned boolean; `false` means the user
 *  cancelled and the open should be aborted.
 *--------------------------------------------------------------------------------------------*/

import {
  localize,
  type IDialogService,
  type IEditorResolverService,
  type IFileService,
  type URI,
} from '@universe-editor/platform'
import { FileEditorInput } from './FileEditorInput.js'

export const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024

/** Binary-detection sample window, matching VSCode's ZERO_BYTE_DETECTION_BUFFER_MAX_LEN. */
export const BINARY_DETECTION_BUFFER_MAX_LEN = 512

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Heuristic: a buffer containing a NUL byte is treated as binary. */
export function isBinaryBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

export async function confirmOpenFile(
  resource: URI,
  fileService: IFileService,
  dialogService: IDialogService,
  resolver: IEditorResolverService,
): Promise<boolean> {
  // Dedicated editors (image preview, PDF, Excel, …) don't feed Monaco a text
  // model, so the large-file warning is irrelevant for them — let them open.
  const top = resolver.resolveEditors(resource)[0]
  if (top && top.info.typeId !== FileEditorInput.TYPE_ID) return true

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

  let binary = false
  try {
    binary = isBinaryBytes(
      await fileService.readFileHead(resource, BINARY_DETECTION_BUFFER_MAX_LEN),
    )
  } catch {
    // Head read failed — fall through to the file-size warning below.
  }

  if (binary) {
    const result = await dialogService.confirm({
      message: localize(
        'dialog.binaryFile.message',
        'The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.',
      ),
      detail: localize(
        'dialog.binaryFile.detail',
        'The file cannot be displayed correctly in the text editor.',
      ),
      primaryButton: localize('dialog.binaryFile.openAnyway', 'Open Anyway'),
      type: 'warning',
    })
    return result.confirmed
  }

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
