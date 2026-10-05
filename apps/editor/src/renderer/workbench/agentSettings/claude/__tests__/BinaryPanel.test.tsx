/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  BinaryPanel tests — a download keeps running in the main process while the
 *  panel is unmounted (switching settings categories tears the component down),
 *  so the panel has to rebuild the in-flight state from the version snapshot and
 *  keep it live from the service event. These tests pin the two halves of that:
 *  a remount mid-download still shows progress, and the version being downloaded
 *  offers no second button to click.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  IConfigurationService,
  IDialogService,
  IHostService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import {
  IClaudeBinaryService,
  type IClaudeBinaryDownloadEvent,
  type IClaudeBinaryVersionInfo,
} from '../../../../../shared/ipc/claudeBinaryService.js'
import { ServicesContext } from '../../../useService.js'
import { BinaryPanel } from '../BinaryPanel.js'
import type { UseClaudeConfig } from '../useClaudeConfig.js'

afterEach(() => cleanup())

/** bundled + installed, with a newer release available. */
function versionInfo(overrides: Partial<IClaudeBinaryVersionInfo> = {}): IClaudeBinaryVersionInfo {
  return {
    bundledVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '2.0.0',
    downloadedVersions: ['1.0.0'],
    downloads: [],
    ...overrides,
  }
}

function makeHarness(initial: IClaudeBinaryVersionInfo, manual = true) {
  let info = initial
  const emitter = new Emitter<IClaudeBinaryDownloadEvent>()
  const getVersionInfo = vi.fn(async () => info)
  const forceDownload = vi.fn(async () => ({ path: '/fake/claude' }))
  const service = {
    _serviceBrand: undefined,
    onDidChangeDownload: emitter.event,
    resolve: vi.fn(async () => ({ path: '/fake/claude' })),
    getVersionInfo,
    prefetch: vi.fn(async () => {}),
    forceDownload,
    cleanupStaleVersions: vi.fn(async () => {}),
  } as unknown as IClaudeBinaryService

  const values: Record<string, unknown> = { 'acp.allowManualBinaryVersion': manual }
  const configEmitter = new Emitter<{ affectsConfiguration(key: string): boolean }>()
  const update = vi.fn(async (key: string, value: unknown) => {
    values[key] = value
    configEmitter.fire({ affectsConfiguration: (k) => k === key })
  })
  const confirm = vi.fn(async () => ({ confirmed: true }))

  const services = new ServiceCollection()
  services.set(IClaudeBinaryService, service)
  services.set(IConfigurationService, {
    get: vi.fn((key: string) => values[key]),
    update,
    onDidChangeConfiguration: configEmitter.event,
  } as unknown as IConfigurationService)
  services.set(INotificationService, { notify: vi.fn() } as unknown as INotificationService)
  services.set(IHostService, { platform: 'linux' } as unknown as IHostService)
  services.set(IDialogService, { confirm } as unknown as IDialogService)
  const inst = new InstantiationService(services)

  return {
    emitter,
    getVersionInfo,
    forceDownload,
    update,
    confirm,
    setInfo: (next: IClaudeBinaryVersionInfo) => {
      info = next
    },
    renderPanel: () =>
      render(<BinaryPanel config={{} as UseClaudeConfig} />, {
        wrapper: ({ children }) => (
          <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
        ),
      }),
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

function progress(version: string, received: number, total: number) {
  return { version, received, total, background: false }
}

describe('BinaryPanel download state', () => {
  it('shows a download that started before the panel mounted, with no second click on that version', async () => {
    const h = makeHarness(versionInfo({ downloads: [progress('2.0.0', 512, 1024)] }))
    h.renderPanel()
    await flushEffects()

    expect(screen.getByText(/50%/)).toBeTruthy()
    // The button for the version already downloading is gone, so there is nothing
    // to click a second time.
    expect(screen.queryByRole('button', { name: /2\.0\.0/ })).toBeNull()
  })

  it('still reports the download after an unmount + remount round trip', async () => {
    const h = makeHarness(versionInfo())
    const first = h.renderPanel()
    await flushEffects()
    expect(screen.queryByText(/%/)).toBeNull()
    first.unmount()

    // The main process kept downloading while the panel was gone.
    h.setInfo(versionInfo({ downloads: [progress('2.0.0', 256, 1024)] }))
    h.renderPanel()
    await flushEffects()

    expect(screen.getByText(/25%/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /2\.0\.0/ })).toBeNull()
  })

  it('keeps the progress live from the service event while mounted', async () => {
    const h = makeHarness(versionInfo())
    h.renderPanel()
    await flushEffects()

    act(() => h.emitter.fire({ downloads: [progress('2.0.0', 25, 100)] }))
    expect(screen.getByText(/25%/)).toBeTruthy()

    act(() => h.emitter.fire({ downloads: [progress('2.0.0', 75, 100)] }))
    expect(screen.getByText(/75%/)).toBeTruthy()
  })

  it('shows the progress row even when the version metadata fails to load', async () => {
    const h = makeHarness(versionInfo())
    h.getVersionInfo.mockRejectedValue(new Error('registry unreachable'))
    h.renderPanel()
    await flushEffects()

    act(() => h.emitter.fire({ downloads: [progress('2.0.0', 25, 100)] }))

    expect(screen.getByText(/25%/)).toBeTruthy()
  })

  it('refreshes the version info once the download queue drains', async () => {
    const h = makeHarness(versionInfo())
    h.renderPanel()
    await flushEffects()
    const before = h.getVersionInfo.mock.calls.length

    act(() => h.emitter.fire({ downloads: [progress('2.0.0', 25, 100)] }))
    // Still busy → no refresh, and the row is on screen.
    expect(h.getVersionInfo.mock.calls.length).toBe(before)
    expect(screen.getByText(/25%/)).toBeTruthy()

    act(() => h.emitter.fire({ downloads: [] }))
    expect(h.getVersionInfo.mock.calls.length).toBe(before + 1)
    // An empty queue means "no download running", not "keep the last frame".
    expect(screen.queryByText(/25%/)).toBeNull()
  })

  it('labels a version already on disk and starts a download only when clicked', async () => {
    const h = makeHarness(versionInfo({ downloadedVersions: ['1.0.0', '2.0.0'] }))
    h.renderPanel()
    await flushEffects()

    expect(screen.getByText(/Available locally: 1\.0\.0, 2\.0\.0/)).toBeTruthy()
    const button = screen.getByRole('button', { name: /2\.0\.0/ })
    expect(button.textContent).toContain('already downloaded')

    fireEvent.click(button)
    await flushEffects()
    expect(h.forceDownload).toHaveBeenCalledWith('2.0.0', undefined)
  })

  it('swaps the clicked button for the progress row and keeps it that way after a remount', async () => {
    const h = makeHarness(versionInfo())
    const first = h.renderPanel()
    await flushEffects()
    fireEvent.click(screen.getByRole('button', { name: /2\.0\.0/ }))
    await flushEffects()
    expect(h.forceDownload).toHaveBeenCalledTimes(1)

    // The store announces the download it just started; the button has to go away
    // now, not when the refresh the click triggers eventually lands.
    act(() => h.emitter.fire({ downloads: [progress('2.0.0', 51, 100)] }))
    expect(screen.getByText(/51%/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /2\.0\.0/ })).toBeNull()

    // Leaving the settings category unmounts the panel while the main process keeps
    // downloading; coming back must not offer the button again.
    first.unmount()
    h.setInfo(versionInfo({ downloads: [progress('2.0.0', 80, 100)] }))
    h.renderPanel()
    await flushEffects()
    expect(screen.getByText(/80%/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /2\.0\.0/ })).toBeNull()
  })

  it('drops its subscription on unmount', async () => {
    const h = makeHarness(versionInfo())
    const view = h.renderPanel()
    await flushEffects()
    act(() => h.emitter.fire({ downloads: [progress('2.0.0', 25, 100)] }))
    view.unmount()
    const before = h.getVersionInfo.mock.calls.length

    // A drained queue is what the live handler refreshes on; if the subscription
    // outlived the component, this fire would trigger a reload.
    expect(() => h.emitter.fire({ downloads: [] })).not.toThrow()
    await flushEffects()
    expect(h.getVersionInfo.mock.calls.length).toBe(before)
  })
})

describe('BinaryPanel version policy', () => {
  it('locks to the pin by default: no latest row, no other version to pick', async () => {
    const h = makeHarness(versionInfo(), false)
    h.renderPanel()
    await flushEffects()

    expect(h.getVersionInfo).toHaveBeenCalledWith('pinned', undefined)
    expect(screen.getByText(/locked to the version this build is pinned to/)).toBeTruthy()
    expect(screen.queryByText(/Latest:/)).toBeNull()
    expect(screen.queryByText(/Available locally:/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Upgrade|Revert|Switch to/ })).toBeNull()
  })

  it('offers the pin when it is missing, even while locked', async () => {
    const h = makeHarness(
      versionInfo({ installedVersion: null, latestVersion: null, downloadedVersions: [] }),
      false,
    )
    h.renderPanel()
    await flushEffects()

    // Downloading the pin is not a version choice, it is the lock being honoured.
    fireEvent.click(screen.getByRole('button', { name: /Download 1\.0\.0/ }))
    await flushEffects()
    expect(h.forceDownload).toHaveBeenCalledWith('1.0.0', undefined)
  })

  it('unlocks only after the confirmation, then re-reads with the manual policy', async () => {
    const h = makeHarness(versionInfo(), false)
    h.renderPanel()
    await flushEffects()
    expect(h.getVersionInfo).toHaveBeenLastCalledWith('pinned', undefined)

    fireEvent.click(screen.getByTestId('binary-version-manual-toggle'))
    await flushEffects()

    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.update).toHaveBeenCalledWith('acp.allowManualBinaryVersion', true, expect.anything())
    expect(h.getVersionInfo).toHaveBeenLastCalledWith('manual', undefined)
    expect(screen.getByText(/Latest:/)).toBeTruthy()
  })

  it('stays locked when the confirmation is dismissed', async () => {
    const h = makeHarness(versionInfo(), false)
    h.confirm.mockResolvedValue({ confirmed: false })
    h.renderPanel()
    await flushEffects()

    fireEvent.click(screen.getByTestId('binary-version-manual-toggle'))
    await flushEffects()

    expect(h.update).not.toHaveBeenCalled()
    expect(h.getVersionInfo).toHaveBeenLastCalledWith('pinned', undefined)
  })

  it('locking back switches to the pin right away and without a confirmation', async () => {
    const h = makeHarness(versionInfo({ installedVersion: '2.0.0' }))
    h.renderPanel()
    await flushEffects()

    fireEvent.click(screen.getByTestId('binary-version-manual-toggle'))
    await flushEffects()

    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.update).toHaveBeenCalledWith('acp.allowManualBinaryVersion', false, expect.anything())
    expect(h.forceDownload).toHaveBeenCalledWith('1.0.0', undefined)
  })
})
