import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  type IConfigurationService,
  type IContextKeyService,
} from '@universe-editor/platform'
import { ActivityService } from '../../services/activity/ActivityService.js'
import { EXTENSIONS_VIEW_CONTAINER_ID } from '../../services/extensionsWorkbench/extensionsViewIds.js'
import type { IExtensionsWorkbenchService } from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import type { IExtensionsUpdateService } from '../../services/extensionsUpdates/ExtensionsUpdateService.js'
import { ExtensionsUpdateContribution } from '../ExtensionsUpdateContribution.js'

const HOUR = 60 * 60 * 1000

function makeFixture(config: Record<string, unknown> = {}) {
  const onDidChange = new Emitter<void>()
  const onDidChangeConfiguration = new Emitter<{ affectsConfiguration(key: string): boolean }>()
  const entries = [
    { id: 'acme.updated', enabled: true, updateVersion: '2.0.0' },
    { id: 'acme.current', enabled: true },
    { id: 'acme.disabled', enabled: false, updateVersion: '2.0.0' },
  ]
  const workbench = {
    onDidChange: onDidChange.event,
    getInstalled: vi.fn(() => entries),
  } as unknown as IExtensionsWorkbenchService
  const updates = {
    check: vi.fn(async () => ({ updates: [] })),
  } as unknown as IExtensionsUpdateService
  const configuration = {
    get: vi.fn((key: string) => config[key]),
    onDidChangeConfiguration: onDidChangeConfiguration.event,
  } as unknown as IConfigurationService
  const activity = new ActivityService()
  /** Every value the contribution pushed into the `extensionsHasUpdates` key. */
  const keyValues: boolean[] = []
  let keyResets = 0
  const contextKeyService = {
    createKey: () => ({
      set: (value: boolean) => keyValues.push(value),
      reset: () => {
        keyResets += 1
      },
      get: () => undefined,
    }),
  } as unknown as IContextKeyService

  const contribution = new ExtensionsUpdateContribution(
    workbench,
    updates,
    configuration,
    activity,
    contextKeyService,
  )
  return {
    contribution,
    workbench,
    updates,
    activity,
    entries,
    onDidChange,
    onDidChangeConfiguration,
    keyValues,
    keyResets: () => keyResets,
    /** Mutable so a test can flip a setting and fire the change event. */
    config,
  }
}

describe('ExtensionsUpdateContribution', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('checks once shortly after startup and then every 12 hours', async () => {
    const f = makeFixture()
    expect(f.updates.check).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.updates.check).toHaveBeenCalledTimes(1)
    expect(f.updates.check).toHaveBeenCalledWith({ auto: true })

    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(f.updates.check).toHaveBeenCalledTimes(2)
    f.contribution.dispose()
  })

  it('registers no timer when automatic checks are off, and arms on re-enable', async () => {
    const f = makeFixture({ 'extensions.autoCheckUpdates': false })

    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(f.updates.check).not.toHaveBeenCalled()

    // Re-enabling is a config change; the next check is deferred again, not immediate.
    f.config['extensions.autoCheckUpdates'] = true
    f.onDidChangeConfiguration.fire({
      affectsConfiguration: (k) => k === 'extensions.autoCheckUpdates',
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.updates.check).toHaveBeenCalledTimes(1)
    f.contribution.dispose()
  })

  it('stops checking after dispose', async () => {
    const f = makeFixture()
    f.contribution.dispose()

    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(f.updates.check).not.toHaveBeenCalled()
  })

  it('re-checks once a publish-delayed candidate becomes eligible', async () => {
    const f = makeFixture()
    const soon = Date.now() + 5 * 60 * 1000
    vi.mocked(f.updates.check).mockResolvedValueOnce({ updates: [], nextEligibleAt: soon })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.updates.check).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(f.updates.check).toHaveBeenCalledTimes(2)
    f.contribution.dispose()
  })

  it('badges only installed, enabled extensions with a pending update', () => {
    const f = makeFixture()
    expect(f.activity.getBadge(EXTENSIONS_VIEW_CONTAINER_ID).get()?.count).toBe(1)
    expect(f.keyValues.at(-1)).toBe(true)

    f.entries.splice(0, f.entries.length, { id: 'acme.updated', enabled: true })
    f.onDidChange.fire()
    expect(f.activity.getBadge(EXTENSIONS_VIEW_CONTAINER_ID).get()).toBeUndefined()
    expect(f.keyValues.at(-1)).toBe(false)

    f.contribution.dispose()
  })

  it('clears the badge when disposed', () => {
    const f = makeFixture()
    expect(f.activity.getBadge(EXTENSIONS_VIEW_CONTAINER_ID).get()?.count).toBe(1)
    f.contribution.dispose()
    expect(f.activity.getBadge(EXTENSIONS_VIEW_CONTAINER_ID).get()).toBeUndefined()
    expect(f.keyResets()).toBe(1)
  })

  it('does not arm a timer from a cycle that resolves after dispose', async () => {
    const f = makeFixture()
    let settle: (result: { updates: readonly never[]; nextEligibleAt?: number }) => void = () =>
      undefined
    vi.mocked(f.updates.check).mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve
      }),
    )

    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.updates.check).toHaveBeenCalledTimes(1)

    f.contribution.dispose()
    settle({ updates: [], nextEligibleAt: Date.now() + 60_000 })
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(f.updates.check).toHaveBeenCalledTimes(1)
  })
})
