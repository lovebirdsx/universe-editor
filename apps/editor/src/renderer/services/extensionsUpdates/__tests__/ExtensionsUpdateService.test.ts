import { describe, expect, it, vi } from 'vitest'
import type { IConfigurationService } from '@universe-editor/platform'
import type { IExtensionsWorkbenchService } from '../../extensionsWorkbench/ExtensionsWorkbenchService.js'
import type { IExtensionUpdate } from '../../../../shared/ipc/extensionManagementService.js'
import { ExtensionsUpdateService } from '../ExtensionsUpdateService.js'

const HOUR = 60 * 60 * 1000

function update(identifier = 'acme.sample', toVersion = '2.0.0'): IExtensionUpdate {
  return {
    identifier,
    fromVersion: '1.0.0',
    toVersion,
    gallery: {
      identifier,
      version: toVersion,
      lastUpdated: new Date(Date.now() - 10 * HOUR).toISOString(),
    },
  } as IExtensionUpdate
}

function makeService(options: {
  updates?: readonly IExtensionUpdate[]
  installed?: readonly { id: string; enabled?: boolean; autoUpdate?: boolean }[]
  config?: Record<string, unknown>
}) {
  const workbench = {
    checkForUpdates: vi.fn(async () => options.updates ?? []),
    getInstalled: vi.fn(() =>
      (options.installed ?? [{ id: 'acme.sample' }]).map((entry) => ({
        id: entry.id,
        enabled: entry.enabled ?? true,
        ...(entry.autoUpdate !== undefined ? { autoUpdate: entry.autoUpdate } : {}),
      })),
    ),
    updateAll: vi.fn(async () => ({ updated: [], failed: [], skipped: [] })),
  } as unknown as IExtensionsWorkbenchService
  const configuration = {
    get: vi.fn((key: string) => options.config?.[key]),
  } as unknown as IConfigurationService
  return { svc: new ExtensionsUpdateService(workbench, configuration), workbench, configuration }
}

describe('ExtensionsUpdateService', () => {
  it('never installs on a non-auto cycle, even with updates pending', async () => {
    const { svc, workbench } = makeService({ updates: [update()] })
    const result = await svc.check()

    expect(result.updates).toHaveLength(1)
    expect(workbench.updateAll).not.toHaveBeenCalled()
  })

  it('installs an eligible update silently on an auto cycle', async () => {
    const { svc, workbench } = makeService({ updates: [update()] })
    await svc.check({ auto: true })

    expect(workbench.updateAll).toHaveBeenCalledWith(['acme.sample'], { silent: true })
  })

  it('detects but never installs when the auto-update setting is off', async () => {
    const { svc, workbench } = makeService({
      updates: [update()],
      config: { 'extensions.autoUpdate': false },
    })
    const result = await svc.check({ auto: true })

    expect(result.updates).toHaveLength(1)
    expect(workbench.updateAll).not.toHaveBeenCalled()
  })

  it('leaves a disabled extension to a manual update', async () => {
    const { svc, workbench } = makeService({
      updates: [update()],
      installed: [{ id: 'acme.sample', enabled: false }],
    })
    await svc.check({ auto: true })

    expect(workbench.updateAll).not.toHaveBeenCalled()
  })

  it('leaves an opted-out extension to a manual update', async () => {
    const { svc, workbench } = makeService({
      updates: [update()],
      installed: [{ id: 'acme.sample', autoUpdate: false }],
    })
    await svc.check({ auto: true })

    expect(workbench.updateAll).not.toHaveBeenCalled()
  })

  it('defers a freshly published update and reports when to look again', async () => {
    const publishedAt = Date.now() - 10 * 60 * 1000
    const fresh = update()
    const { svc, workbench } = makeService({
      updates: [
        {
          ...fresh,
          gallery: { ...fresh.gallery, lastUpdated: new Date(publishedAt).toISOString() },
        },
      ],
      config: { 'extensions.autoUpdateDelay': 2 },
    })

    const result = await svc.check({ auto: true })

    expect(workbench.updateAll).not.toHaveBeenCalled()
    expect(result.nextEligibleAt).toBe(publishedAt + 2 * HOUR)
  })

  it('applies immediately when the delay is configured to zero', async () => {
    const publishedAt = Date.now()
    const fresh = update()
    const { svc, workbench } = makeService({
      updates: [
        {
          ...fresh,
          gallery: { ...fresh.gallery, lastUpdated: new Date(publishedAt).toISOString() },
        },
      ],
      config: { 'extensions.autoUpdateDelay': 0 },
    })
    const result = await svc.check({ auto: true })

    expect(workbench.updateAll).toHaveBeenCalledTimes(1)
    expect(result.nextEligibleAt).toBeUndefined()
  })
})
