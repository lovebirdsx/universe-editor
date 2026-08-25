import { describe, expect, it, vi } from 'vitest'
import { NullLogger, URI, type IDialogService, type IFileService } from '@universe-editor/platform'
import { importDroppedResources } from '../importDroppedFiles.js'

interface ConfirmCall {
  readonly type?: string
  readonly message?: string
  readonly detail?: string
}

function makeServices(opts?: {
  exists?: boolean | ((dest: URI) => boolean)
  copy?: (src: URI, dest: URI, overwrite?: { overwrite?: boolean }) => Promise<void>
  confirmDecisions?: boolean[]
}) {
  const copy = vi.fn(async (src: URI, dest: URI, overwrite?: { overwrite?: boolean }) => {
    await opts?.copy?.(src, dest, overwrite)
  })
  const fileService = {
    exists: vi.fn(async (dest: URI) =>
      typeof opts?.exists === 'function' ? opts.exists(dest) : (opts?.exists ?? false),
    ),
    copy,
  } as unknown as IFileService
  const confirm = vi.fn(async (call: ConfirmCall) => {
    const confirmed = call.type === 'error' ? true : (opts?.confirmDecisions?.shift() ?? true)
    return { confirmed, choice: confirmed ? 'primary' : 'cancel' }
  })
  const dialogService = { confirm } as unknown as IDialogService
  return { fileService, dialogService, copy, confirm }
}

function errorDialogCalls(confirm: ReturnType<typeof vi.fn>): ConfirmCall[] {
  return confirm.mock.calls
    .map((call) => call[0] as ConfirmCall)
    .filter((call) => call.type === 'error')
}

describe('importDroppedResources', () => {
  const destDir = URI.file('/dst')
  const src = URI.file('/a/x.ts')

  it('copies straight in when the target does not exist', async () => {
    const { fileService, dialogService, copy, confirm } = makeServices()
    await importDroppedResources([src], destDir, fileService, dialogService)
    expect(confirm).not.toHaveBeenCalled()
    expect(copy).toHaveBeenCalledWith(src, URI.file('/dst/x.ts'))
  })

  it('overwrites after a confirmed replace prompt', async () => {
    const { fileService, dialogService, copy, confirm } = makeServices({ exists: true })
    await importDroppedResources([src], destDir, fileService, dialogService)
    expect(confirm).toHaveBeenCalledOnce()
    expect(copy).toHaveBeenCalledWith(src, URI.file('/dst/x.ts'), { overwrite: true })
  })

  it('skips the copy when the replace prompt is declined', async () => {
    const { fileService, dialogService, copy, confirm } = makeServices({
      exists: true,
      confirmDecisions: [false],
    })
    await importDroppedResources([src], destDir, fileService, dialogService)
    expect(copy).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledOnce()
    expect(errorDialogCalls(confirm)).toHaveLength(0)
  })

  it('is a no-op when dropped onto its own containing folder', async () => {
    const { fileService, dialogService, copy } = makeServices({ exists: true })
    await importDroppedResources([URI.file('/dst/x.ts')], destDir, fileService, dialogService)
    expect(copy).not.toHaveBeenCalled()
  })

  it('shows no dialog when everything succeeds, including confirmed replaces', async () => {
    const { fileService, dialogService, copy, confirm } = makeServices({
      exists: (dest) => dest.path === '/dst/a.ts',
    })
    await importDroppedResources(
      [URI.file('/a/a.ts'), URI.file('/a/b.ts')],
      destDir,
      fileService,
      dialogService,
    )
    expect(copy).toHaveBeenCalledTimes(2)
    expect(errorDialogCalls(confirm)).toHaveLength(0)
  })

  it('keeps importing the rest of the batch when one file fails', async () => {
    const { fileService, dialogService, copy, confirm } = makeServices({
      copy: async (source) => {
        if (source.path.endsWith('/b.ts')) throw new Error('disk full')
      },
    })
    await importDroppedResources(
      [URI.file('/a/a.ts'), URI.file('/a/b.ts'), URI.file('/a/c.ts')],
      destDir,
      fileService,
      dialogService,
    )
    expect(copy).toHaveBeenCalledTimes(3)
    const errors = errorDialogCalls(confirm)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('b.ts')
    expect(errors[0]!.detail).toContain('disk full')
  })

  it('aggregates multiple failures with a count in the message', async () => {
    const { fileService, dialogService, copy, confirm } = makeServices({
      copy: async (source) => {
        if (source.path.endsWith('/a.ts')) throw new Error('boom A')
        if (source.path.endsWith('/b.ts')) throw new Error('boom B')
      },
    })
    await importDroppedResources(
      [URI.file('/a/a.ts'), URI.file('/a/b.ts'), URI.file('/a/c.ts'), URI.file('/a/d.ts')],
      destDir,
      fileService,
      dialogService,
    )
    expect(copy).toHaveBeenCalledTimes(4)
    const errors = errorDialogCalls(confirm)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('2 of 4')
    expect(errors[0]!.detail).toContain('a.ts')
    expect(errors[0]!.detail).toContain('boom A')
    expect(errors[0]!.detail).toContain('b.ts')
    expect(errors[0]!.detail).toContain('boom B')
  })

  it('does not count a declined replace prompt as a failure', async () => {
    const { fileService, dialogService, copy, confirm } = makeServices({
      exists: (dest) => dest.path === '/dst/a.ts',
      confirmDecisions: [false],
      copy: async (source) => {
        if (source.path.endsWith('/b.ts')) throw new Error('nope')
      },
    })
    await importDroppedResources(
      [URI.file('/a/a.ts'), URI.file('/a/b.ts')],
      destDir,
      fileService,
      dialogService,
    )
    expect(copy).toHaveBeenCalledTimes(1)
    const errors = errorDialogCalls(confirm)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('b.ts')
    expect(errors[0]!.detail).not.toContain('a.ts')
  })

  it('displays thrown values that are not Error instances', async () => {
    const { fileService, dialogService, confirm } = makeServices({
      copy: async () => {
        throw 'permission denied'
      },
    })
    await importDroppedResources([src], destDir, fileService, dialogService)
    const errors = errorDialogCalls(confirm)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.detail).toContain('permission denied')
  })

  it('logs each failed copy', async () => {
    const logger = new NullLogger()
    const errorSpy = vi.spyOn(logger, 'error')
    const { fileService, dialogService } = makeServices({
      copy: async (source) => {
        if (source.path.endsWith('/b.ts')) throw new Error('disk full')
      },
    })
    await importDroppedResources(
      [URI.file('/a/a.ts'), URI.file('/a/b.ts')],
      destDir,
      fileService,
      dialogService,
      logger,
    )
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]![0]).toContain('b.ts')
    expect(errorSpy.mock.calls[0]![0]).toContain('disk full')
  })
})
