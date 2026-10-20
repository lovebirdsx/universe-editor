/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/workspace/electronFolderOpenGuard.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NullLogger, URI } from '@universe-editor/platform'

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() },
}))

const { dialog } = await import('electron')
const { ElectronFolderOpenGuard } = await import('../electronFolderOpenGuard.js')

const showMessageBox = vi.mocked(dialog.showMessageBox) as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  showMessageBox.mockReset()
  showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
})

function makeGuard(opts: { e2eEnabled?: boolean; parent?: unknown } = {}) {
  const logger = new NullLogger()
  const info = vi.spyOn(logger, 'info')
  const warn = vi.spyOn(logger, 'warn')
  const guard = new ElectronFolderOpenGuard({
    e2eEnabled: opts.e2eEnabled ?? false,
    logger,
    getParentWindow: () => (opts.parent ?? null) as never,
  })
  return { guard, info, warn }
}

const folder = URI.file('/tmp/gone')

describe('ElectronFolderOpenGuard.report', () => {
  it('shows the VSCode "Path does not exist" info box', async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const { guard } = makeGuard()
    await guard.report(folder, { problem: 'not-found' })

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    const options = showMessageBox.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options).toMatchObject({
      type: 'info',
      message: 'Path does not exist',
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    expect(options.detail).toContain(folder.fsPath)
  })

  it('shows "not a folder" for an existing file', async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const { guard } = makeGuard()
    await guard.report(folder, { problem: 'not-a-directory' })

    const options = showMessageBox.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options).toMatchObject({ type: 'info', message: 'Path is not a folder' })
    expect(options.detail).toContain(folder.fsPath)
  })

  it('keeps the entry and surfaces the OS error when the folder is unavailable', async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const { guard } = makeGuard()
    const error = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    await guard.report(folder, { problem: 'unavailable', error })

    const options = showMessageBox.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options).toMatchObject({ type: 'warning', message: 'Unable to open folder' })
    expect(options.detail).toContain(folder.fsPath)
    expect(options.detail).toContain('EACCES: permission denied')
  })

  it('uses the live window as the dialog parent', async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const parent = { isDestroyed: () => false }
    const { guard } = makeGuard({ parent })
    await guard.report(folder, { problem: 'not-found' })

    expect(showMessageBox.mock.calls[0]?.[0]).toBe(parent)
    expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({ message: 'Path does not exist' })
  })

  it('falls back to the parentless overload when the window is gone', async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const { guard } = makeGuard({ parent: { isDestroyed: () => true } })
    await guard.report(folder, { problem: 'not-found' })

    expect(showMessageBox.mock.calls[0]).toHaveLength(1)
    expect(showMessageBox.mock.calls[0]?.[0]).toMatchObject({ message: 'Path does not exist' })
  })

  it('suppresses the native dialog in E2E', async () => {
    const { guard, info } = makeGuard({ e2eEnabled: true })
    await guard.report(folder, { problem: 'not-found' })

    expect(showMessageBox).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('dialog suppressed'))
  })

  it('swallows dialog failures', async () => {
    showMessageBox.mockRejectedValue(new Error('dialog exploded'))
    const { guard, warn } = makeGuard()

    await expect(guard.report(folder, { problem: 'not-found' })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
