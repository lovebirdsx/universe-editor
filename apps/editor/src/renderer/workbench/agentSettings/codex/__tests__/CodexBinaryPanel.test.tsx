/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexBinaryPanel mirrors BinaryPanel line for line, so this file only pins the
 *  mirrored wiring that a copy-paste edit is most likely to break: the download
 *  state comes from the service (not from component-local state) and the version
 *  being downloaded offers no button. The full matrix lives next to the claude
 *  panel in ../claude/__tests__/BinaryPanel.test.tsx.
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
  ICodexBinaryService,
  type ICodexBinaryDownloadEvent,
  type ICodexBinaryVersionInfo,
} from '../../../../../shared/ipc/codexBinaryService.js'
import { ServicesContext } from '../../../useService.js'
import { CodexBinaryPanel } from '../CodexBinaryPanel.js'
import type { UseCodexConfig } from '../useCodexConfig.js'

afterEach(() => cleanup())

function versionInfo(overrides: Partial<ICodexBinaryVersionInfo> = {}): ICodexBinaryVersionInfo {
  return {
    bundledVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '2.0.0',
    downloadedVersions: ['1.0.0'],
    downloads: [],
    ...overrides,
  }
}

function makeHarness(initial: ICodexBinaryVersionInfo) {
  let info = initial
  const emitter = new Emitter<ICodexBinaryDownloadEvent>()
  const forceDownload = vi.fn(async () => ({ path: '/fake/codex' }))
  const service = {
    _serviceBrand: undefined,
    onDidChangeDownload: emitter.event,
    resolve: vi.fn(async () => ({ path: '/fake/codex' })),
    getVersionInfo: vi.fn(async () => info),
    prefetch: vi.fn(async () => {}),
    forceDownload,
    cleanupStaleVersions: vi.fn(async () => {}),
  } as unknown as ICodexBinaryService

  const services = new ServiceCollection()
  services.set(ICodexBinaryService, service)
  services.set(IConfigurationService, {
    get: vi.fn(() => undefined),
    update: vi.fn(async () => {}),
  } as unknown as IConfigurationService)
  services.set(INotificationService, { notify: vi.fn() } as unknown as INotificationService)
  services.set(IHostService, { platform: 'linux' } as unknown as IHostService)
  const inst = new InstantiationService(services)

  return {
    emitter,
    forceDownload,
    setInfo: (next: ICodexBinaryVersionInfo) => {
      info = next
    },
    renderPanel: () =>
      render(<CodexBinaryPanel config={{} as UseCodexConfig} />, {
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

describe('CodexBinaryPanel download state', () => {
  it('shows an in-flight download on mount and offers no second click on it', async () => {
    const h = makeHarness(versionInfo({ downloads: [progress('2.0.0', 512, 1024)] }))
    h.renderPanel()
    await flushEffects()

    expect(screen.getByText(/50%/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /2\.0\.0/ })).toBeNull()
  })

  it('swaps the clicked button for the progress row', async () => {
    const h = makeHarness(versionInfo())
    h.renderPanel()
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: /2\.0\.0/ }))
    await flushEffects()
    expect(h.forceDownload).toHaveBeenCalledWith('2.0.0', undefined)

    // The live event — not the refresh the click triggers — is what has to remove
    // the button, otherwise a click shows a progress row and a clickable button.
    act(() => h.emitter.fire({ downloads: [progress('2.0.0', 51, 100)] }))
    expect(screen.getByText(/51%/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /2\.0\.0/ })).toBeNull()
  })
})
