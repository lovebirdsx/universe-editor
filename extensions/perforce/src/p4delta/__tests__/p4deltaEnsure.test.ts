import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureP4delta, type P4deltaEnsureOptions } from '../p4deltaEnsure.js'
import type { P4deltaStore, P4deltaSyncOutcome } from '../p4deltaStore.js'
import { P4DELTA_DEFAULT_SOURCE } from '../p4deltaUpstream.js'

const mocks = vi.hoisted(() => ({
  named: vi.fn<(configuredPath: string) => boolean>(),
  resolve: vi.fn<(configuredPath?: string, managedRoot?: string) => unknown>(),
}))

vi.mock('../p4deltaService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../p4deltaService.js')>()
  return {
    ...actual,
    p4deltaNamedExplicitly: (configuredPath: string) => mocks.named(configuredPath),
    resolveP4deltaCommand: (configuredPath?: string, managedRoot?: string) =>
      mocks.resolve(configuredPath, managedRoot),
  }
})

const storeMocks = vi.hoisted(() => ({
  activeManaged: vi.fn<(root: string) => string | undefined>(),
  open: vi.fn(),
}))

vi.mock('../p4deltaStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../p4deltaStore.js')>()
  return {
    ...actual,
    activeManagedP4delta: (root: string) => storeMocks.activeManaged(root),
    openP4deltaStore: (options: unknown) => storeMocks.open(options),
  }
})

interface FakeStore {
  readonly store: P4deltaStore
  readonly sync: ReturnType<typeof vi.fn>
}

function fakeStore(outcome: P4deltaSyncOutcome, activeExe?: string): FakeStore {
  const sync = vi.fn(async () => outcome)
  return {
    sync,
    store: {
      sync,
      activeExe: () => activeExe,
      cleanup: async () => {},
    },
  }
}

const BASE: P4deltaEnsureOptions = {
  root: '/store/p4delta',
  enabled: true,
  autoInstall: true,
  configuredPath: '',
  source: P4DELTA_DEFAULT_SOURCE,
  log: () => {},
  platform: 'win32',
  arch: 'x64',
}

function options(overrides: Partial<P4deltaEnsureOptions> = {}): P4deltaEnsureOptions {
  return { ...BASE, ...overrides }
}

describe('ensureP4delta: the cases that must not touch the network', () => {
  beforeEach(() => {
    mocks.named.mockReset().mockReturnValue(false)
    mocks.resolve.mockReset().mockReturnValue(undefined)
    storeMocks.activeManaged.mockReset().mockReturnValue(undefined)
    storeMocks.open.mockReset()
  })

  it('does nothing without a managed root', async () => {
    const result = await ensureP4delta(options({ root: '' }))
    expect(result.outcome).toEqual({ kind: 'skipped', reason: 'no global storage for this host' })
    expect(result.changed).toBe(false)
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  it('does nothing on a platform upstream publishes no build for', async () => {
    const result = await ensureP4delta(options({ platform: 'linux' }))
    expect(result.outcome.kind).toBe('skipped')
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  it('does nothing when the master switch is off', async () => {
    const result = await ensureP4delta(options({ enabled: false }))
    expect(result.outcome).toEqual({
      kind: 'skipped',
      reason: 'p4delta is turned off by perforce.p4delta.enabled',
    })
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  // Turning auto-install off is a user saying "I will do this myself" — which is
  // what the manual command is FOR, so the background run must not be its gate.
  it('leaves the manual command alone when automatic installation is off', async () => {
    const fake = fakeStore({ kind: 'installed', version: '0.1.10' })
    storeMocks.open.mockReturnValue(fake.store)
    const automatic = await ensureP4delta(options({ autoInstall: false }))
    expect(automatic.outcome).toEqual({
      kind: 'skipped',
      reason: 'automatic installation is off; run the install command instead',
    })
    expect(storeMocks.open).not.toHaveBeenCalled()

    const manual = await ensureP4delta(options({ autoInstall: false }), true)
    expect(manual.outcome).toEqual({ kind: 'installed', version: '0.1.10' })
  })

  it('still refuses the manual command with the master switch off', async () => {
    const result = await ensureP4delta(options({ enabled: false, autoInstall: false }), true)
    expect(result.outcome.kind).toBe('skipped')
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  it('stays out of the way when an engine was named explicitly', async () => {
    mocks.named.mockReturnValue(true)
    const result = await ensureP4delta(options({ configuredPath: '/opt/p4delta' }))
    expect(result.outcome).toEqual({
      kind: 'skipped',
      reason: 'a p4delta was named explicitly',
    })
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  it('stays out of the way when the machine already has its own copy', async () => {
    mocks.resolve.mockReturnValue({ exe: '/usr/bin/p4delta', source: 'path' })
    const result = await ensureP4delta(options())
    expect(result.outcome).toEqual({
      kind: 'skipped',
      reason: 'this machine already has one (/usr/bin/p4delta)',
    })
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  // The gate refuses δ outright when this session's p4 is a script, so the copy
  // this module would download is one the session that paid for it cannot use.
  it('does not download for a session whose p4 is a script override', async () => {
    const result = await ensureP4delta(options({ p4IsScriptOverride: true }))
    expect(result.outcome).toEqual({
      kind: 'skipped',
      reason: "this session's p4 is a script override; a managed copy would go unused",
    })
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  it('looks only at the self-installed tiers when judging that', async () => {
    await ensureP4delta(options())
    // No managed root passed: the resolver must not be able to answer with the
    // copy this very module maintains.
    expect(mocks.resolve).toHaveBeenCalledWith('', undefined)
  })
})

describe('ensureP4delta: forced (the manual command)', () => {
  beforeEach(() => {
    mocks.named.mockReset().mockReturnValue(true)
    mocks.resolve.mockReset().mockReturnValue({ exe: '/usr/bin/p4delta', source: 'path' })
    storeMocks.activeManaged.mockReset().mockReturnValue(undefined)
    storeMocks.open.mockReset()
  })

  it('installs even when an engine was named and another copy exists', async () => {
    const fake = fakeStore({ kind: 'installed', version: '0.1.10' })
    storeMocks.open.mockReturnValue(fake.store)
    const result = await ensureP4delta(options({ configuredPath: '/opt/p4delta' }), true)
    expect(result.outcome).toEqual({ kind: 'installed', version: '0.1.10' })
    expect(result.changed).toBe(true)
    expect(fake.sync).toHaveBeenCalledWith(true, undefined)
  })

  it('installs under a script override too — the copy is for the machine', async () => {
    const fake = fakeStore({ kind: 'installed', version: '0.1.10' })
    storeMocks.open.mockReturnValue(fake.store)
    const result = await ensureP4delta(options({ p4IsScriptOverride: true }), true)
    expect(result.outcome).toEqual({ kind: 'installed', version: '0.1.10' })
  })
})

describe('ensureP4delta: running the store', () => {
  beforeEach(() => {
    mocks.named.mockReset().mockReturnValue(false)
    mocks.resolve.mockReset().mockReturnValue(undefined)
    storeMocks.activeManaged.mockReset().mockReturnValue(undefined)
    storeMocks.open.mockReset()
  })

  it('reports a change when a version was activated', async () => {
    const fake = fakeStore({ kind: 'installed', version: '0.1.10', previousVersion: '0.1.9' })
    storeMocks.open.mockReturnValue(fake.store)
    const result = await ensureP4delta(options())
    expect(result.changed).toBe(true)
    expect(result.outcome).toMatchObject({ version: '0.1.10' })
  })

  it('reports no change when the copy was already current', async () => {
    storeMocks.activeManaged.mockReturnValue('/store/p4delta/0.1.10/p4delta.exe')
    storeMocks.open.mockReturnValue(fakeStore({ kind: 'up-to-date', version: '0.1.10' }).store)
    const result = await ensureP4delta(options())
    expect(result.changed).toBe(false)
  })

  it('reports a change when another window installed while we asked', async () => {
    // The gate could not see a managed copy when it resolved; by the time the
    // store answers, one is on disk (another window got there first).
    storeMocks.activeManaged.mockReturnValue(undefined)
    const fake = fakeStore(
      { kind: 'up-to-date', version: '0.1.10' },
      '/store/p4delta/0.1.10/p4delta.exe',
    )
    storeMocks.open.mockReturnValue(fake.store)
    const result = await ensureP4delta(options())
    expect(result.changed).toBe(true)
  })

  it('reports no change for a throttled or failed run', async () => {
    storeMocks.open.mockReturnValue(fakeStore({ kind: 'throttled', nextCheckAt: 1 }).store)
    expect((await ensureP4delta(options())).changed).toBe(false)
    storeMocks.open.mockReturnValue(fakeStore({ kind: 'failed', reason: 'offline' }).store)
    expect((await ensureP4delta(options())).changed).toBe(false)
  })

  // The background path has no other surface: the store settles instead of
  // throwing, so nobody else would ever put the reason in front of a user
  // staring at a log wondering why the acceleration never arrives.
  it('writes the failure reason to the log', async () => {
    const log = vi.fn()
    storeMocks.open.mockReturnValue(fakeStore({ kind: 'failed', reason: 'offline' }).store)
    await ensureP4delta(options({ log }))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'))
  })

  it('notes a cancellation as one, not as a failure', async () => {
    const log = vi.fn()
    storeMocks.open.mockReturnValue(fakeStore({ kind: 'cancelled' }).store)
    await ensureP4delta(options({ log }))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cancelled'))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('failed'))
  })

  it('passes the source, platform and logger down to the store', async () => {
    const log = vi.fn()
    storeMocks.open.mockReturnValue(fakeStore({ kind: 'up-to-date', version: '0.1.10' }).store)
    await ensureP4delta(options({ log }))
    expect(storeMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        root: '/store/p4delta',
        source: P4DELTA_DEFAULT_SOURCE,
        platform: 'win32',
        arch: 'x64',
        log,
      }),
    )
  })

  it('passes the admission floor down to the store', async () => {
    storeMocks.open.mockReturnValue(fakeStore({ kind: 'up-to-date', version: '0.1.19' }).store)
    await ensureP4delta(options({ minimumVersion: [0, 1, 19] }))
    expect(storeMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ minimumVersion: [0, 1, 19] }),
    )
  })

  it('omits the floor key when none is given', async () => {
    storeMocks.open.mockReturnValue(fakeStore({ kind: 'up-to-date', version: '0.1.10' }).store)
    await ensureP4delta(options())
    const opened = storeMocks.open.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opened).not.toHaveProperty('minimumVersion')
  })

  it('turns a store that throws into a failure outcome', async () => {
    storeMocks.open.mockReturnValue({
      sync: vi.fn(async () => {
        throw new Error('the disk caught fire')
      }),
      activeExe: () => undefined,
      cleanup: async () => {},
    })
    const result = await ensureP4delta(options())
    expect(result.outcome).toEqual({ kind: 'failed', reason: 'the disk caught fire' })
    expect(result.changed).toBe(false)
  })
})

// 「机器已有副本」是省流规则不是正确性规则：只在本安装盘上一份自己的都没有时成立；托管副本是本安装要持续升级的那份，不能被机器上更旧的自装副本钉死（见 docs/reconcile.md）。
describe('ensureP4delta: a managed copy keeps upgrading', () => {
  beforeEach(() => {
    mocks.named.mockReset().mockReturnValue(false)
    mocks.resolve.mockReset().mockReturnValue({ exe: '/usr/bin/p4delta', source: 'path' })
    storeMocks.activeManaged.mockReset()
    storeMocks.open.mockReset()
  })

  it('runs the store even when the machine has its own copy', async () => {
    storeMocks.activeManaged.mockReturnValue('/store/p4delta/0.1.11/p4delta.exe')
    const fake = fakeStore({ kind: 'installed', version: '0.1.12', previousVersion: '0.1.11' })
    storeMocks.open.mockReturnValue(fake.store)
    const result = await ensureP4delta(options())
    expect(result.outcome).toMatchObject({ kind: 'installed', version: '0.1.12' })
    expect(result.changed).toBe(true)
    expect(fake.sync).toHaveBeenCalledWith(false, undefined)
  })

  it('still stays out of the way when there is no managed copy behind the pointer', async () => {
    storeMocks.activeManaged.mockReturnValue(undefined)
    const result = await ensureP4delta(options())
    expect(result.outcome).toEqual({
      kind: 'skipped',
      reason: 'this machine already has one (/usr/bin/p4delta)',
    })
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  it('still stays away when an engine was named explicitly', async () => {
    mocks.named.mockReturnValue(true)
    storeMocks.activeManaged.mockReturnValue('/store/p4delta/0.1.11/p4delta.exe')
    const result = await ensureP4delta(options({ configuredPath: '/opt/p4delta' }))
    expect(result.outcome).toEqual({ kind: 'skipped', reason: 'a p4delta was named explicitly' })
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  it('still stays away under a p4 script override', async () => {
    storeMocks.activeManaged.mockReturnValue('/store/p4delta/0.1.11/p4delta.exe')
    const result = await ensureP4delta(options({ p4IsScriptOverride: true }))
    expect(result.outcome).toEqual({
      kind: 'skipped',
      reason: "this session's p4 is a script override; a managed copy would go unused",
    })
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  it('still honors the master switch and the auto-install setting', async () => {
    storeMocks.activeManaged.mockReturnValue('/store/p4delta/0.1.11/p4delta.exe')
    expect((await ensureP4delta(options({ enabled: false }))).outcome.kind).toBe('skipped')
    expect((await ensureP4delta(options({ autoInstall: false }))).outcome.kind).toBe('skipped')
    expect(storeMocks.open).not.toHaveBeenCalled()
  })

  it('reports no change when the managed copy is already current', async () => {
    storeMocks.activeManaged.mockReturnValue('/store/p4delta/0.1.12/p4delta.exe')
    storeMocks.open.mockReturnValue(fakeStore({ kind: 'up-to-date', version: '0.1.12' }).store)
    const result = await ensureP4delta(options())
    expect(result.changed).toBe(false)
  })
})
