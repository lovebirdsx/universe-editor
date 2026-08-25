/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Copy-imports dropped resources into an Explorer directory, mirroring VSCode:
 *  each source is copied to `destDir/<basename>`; an existing target prompts a
 *  replace confirmation before overwriting. Dropping items onto their own
 *  containing folder is a no-op. A failing source does not abort the rest of the
 *  batch; failures are aggregated and reported in one dialog at the end.
 *--------------------------------------------------------------------------------------------*/

import {
  localize,
  NullLogger,
  type IDialogService,
  type IFileService,
  type ILogger,
  type URI,
} from '@universe-editor/platform'

interface CopyFailure {
  readonly name: string
  readonly error: string
}

export async function importDroppedResources(
  sources: readonly URI[],
  destDir: URI,
  fileService: IFileService,
  dialogService: IDialogService,
  logger?: ILogger,
): Promise<void> {
  const log = logger ?? new NullLogger()
  const failures: CopyFailure[] = []

  for (const src of sources) {
    const name = src.path
      .split('/')
      .filter((s) => s.length > 0)
      .pop()
    if (!name) continue
    const dest = destDir.with({ path: `${destDir.path}/${name}` })
    if (dest.toString() === src.toString()) continue

    try {
      if (await fileService.exists(dest)) {
        const { confirmed } = await dialogService.confirm({
          message: localize(
            'dnd.replaceExisting.message',
            'A file or folder with the name "{name}" already exists in the destination folder. Do you want to replace it?',
            { name },
          ),
          detail: localize('dnd.replaceExisting.detail', 'This action is irreversible!'),
          primaryButton: localize('common.replace', 'Replace'),
          type: 'warning',
        })
        if (!confirmed) continue
        await fileService.copy(src, dest, { overwrite: true })
      } else {
        await fileService.copy(src, dest)
      }
      log.info(`importDroppedResources copied ${src.toString()} -> ${dest.toString()}`)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.error(
        `importDroppedResources copy failed ${src.toString()} -> ${dest.toString()} err=${error}`,
      )
      failures.push({ name, error })
    }
  }

  if (failures.length === 0) return
  await dialogService.confirm({
    message:
      failures.length === 1
        ? localize('dnd.copyFailed.message', 'Failed to copy "{name}".', {
            name: failures[0]!.name,
          })
        : localize('dnd.copyFailed.message.multiple', 'Failed to copy {failed} of {total} items.', {
            failed: failures.length,
            total: sources.length,
          }),
    detail: failures.map((f) => `${f.name}: ${f.error}`).join('\n'),
    type: 'error',
  })
}
