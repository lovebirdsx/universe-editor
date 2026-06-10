import { describe, expect, it, vi } from 'vitest'
import { URI, type IDialogService, type IFileService } from '@universe-editor/platform'
import { importDroppedResources } from '../importDroppedFiles.js'

function makeServices(exists: boolean, confirmed = true) {
  const copy = vi.fn(async () => {})
  const fileService = {
    exists: vi.fn(async () => exists),
    copy,
  } as unknown as IFileService
  const confirm = vi.fn(async () => ({ confirmed, choice: confirmed ? 'primary' : 'cancel' }))
  const dialogService = { confirm } as unknown as IDialogService
  return { fileService, dialogService, copy, confirm }
}

describe('importDroppedResources', () => {
  const destDir = URI.file('/dst')
  const src = URI.file('/a/x.ts')

  it('copies straight in when the target does not exist', async () => {
    const { fileService, dialogService, copy, confirm } = makeServices(false)
    await importDroppedResources([src], destDir, fileService, dialogService)
    expect(confirm).not.toHaveBeenCalled()
    expect(copy).toHaveBeenCalledWith(src, URI.file('/dst/x.ts'))
  })

  it('overwrites after a confirmed replace prompt', async () => {
    const { fileService, dialogService, copy, confirm } = makeServices(true, true)
    await importDroppedResources([src], destDir, fileService, dialogService)
    expect(confirm).toHaveBeenCalledOnce()
    expect(copy).toHaveBeenCalledWith(src, URI.file('/dst/x.ts'), { overwrite: true })
  })

  it('skips the copy when the replace prompt is declined', async () => {
    const { fileService, dialogService, copy } = makeServices(true, false)
    await importDroppedResources([src], destDir, fileService, dialogService)
    expect(copy).not.toHaveBeenCalled()
  })

  it('is a no-op when dropped onto its own containing folder', async () => {
    const { fileService, dialogService, copy } = makeServices(true)
    await importDroppedResources([URI.file('/dst/x.ts')], destDir, fileService, dialogService)
    expect(copy).not.toHaveBeenCalled()
  })
})
