/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Copy-imports dropped resources into an Explorer directory, mirroring VSCode:
 *  each source is copied to `destDir/<basename>`; an existing target prompts a
 *  replace confirmation before overwriting. Dropping items onto their own
 *  containing folder is a no-op.
 *--------------------------------------------------------------------------------------------*/

import { type IDialogService, type IFileService, type URI } from '@universe-editor/platform'

export async function importDroppedResources(
  sources: readonly URI[],
  destDir: URI,
  fileService: IFileService,
  dialogService: IDialogService,
): Promise<void> {
  for (const src of sources) {
    const name = src.path
      .split('/')
      .filter((s) => s.length > 0)
      .pop()
    if (!name) continue
    const dest = destDir.with({ path: `${destDir.path}/${name}` })
    if (dest.toString() === src.toString()) continue

    if (await fileService.exists(dest)) {
      const { confirmed } = await dialogService.confirm({
        message: `A file or folder with the name "${name}" already exists in the destination folder. Do you want to replace it?`,
        detail: 'This action is irreversible!',
        primaryButton: 'Replace',
        type: 'warning',
      })
      if (!confirmed) continue
      await fileService.copy(src, dest, { overwrite: true })
    } else {
      await fileService.copy(src, dest)
    }
  }
}
