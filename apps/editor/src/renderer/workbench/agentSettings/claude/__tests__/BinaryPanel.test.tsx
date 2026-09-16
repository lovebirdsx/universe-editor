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

function makeHarness(initial: IClaudeBinaryVersionInfo) {
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

  const services = new ServiceCollection()
  services.set(IClaudeBinaryService, service)
  services.set(IConfigurationService, {
    get: vi.fn(() => undefined),
    update: vi.fn(async () => {}),
  } as unknown as IConfigurationService)
  services.set(INotificationService, { notify: vi.fn() } as unknown as INotificationService)
  services.set(IHostService, { platform: 'linux' } as unknown as IHostService)
  const inst = new InstantiationService(services)

  return {
    emitter,
    getVersionInfo,
    forceDownload,
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
