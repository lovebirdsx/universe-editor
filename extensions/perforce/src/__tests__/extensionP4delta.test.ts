/**
 * The δ engine gate in `activate`: `resolveP4deltaEngine` is the ONE decision
 * helper both client construction points share, so its rules are pinned here.
 *  1. `perforce.p4delta.enabled: false` must not even RESOLVE the binary — no
 *     path lookup, no filesystem check, no version probe.
 *  2. A `p4` script override (the e2e fake) keeps the session native UNLESS the
 *     operator named δ too (the env override or the setting) — that is the e2e
 *     fixture's "both engines are mine" case, and there δ must go out carrying
 *     `P4_EXE` so its hand-offs reach the same fake p4.
 *  3. A missing executable (nothing resolved, or a resolved path that is not
 *     there) degrades to native with a log line — never an error dialog, never a
 *     throw.
 *  4. A binary that exists is admitted only when `probeP4deltaBuild` reports
 *     `>= P4DELTA_MIN_VERSION`. The gate is fail-closed: a build below the floor
 *     or one whose banner cannot be read is refused (native p4) and the optional
 *     refusal callback fires once.
 *  5. The managed copy (p4deltaStore) sits between the named tiers and the
 *     machine's own: `managedRoot` reaches the resolver, and whatever it answers
 *     is admitted on the same existence + version terms. 托管副本压过 PATH / `%LOCALAPPDATA%`，升级才不会被机器上更旧的副本遮蔽（见 `resolveP4deltaCommand`）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { P4deltaCandidate } from '../p4delta/p4deltaService.js'
import type { P4deltaVersion } from '../p4delta/p4deltaVersion.js'

// extension.ts pulls in the whole extension surface at import time; stub the API
// so importing the gate helper doesn't require the real host (same shape as
// setActiveRepo.test.ts).
vi.mock('@universe-editor/extension-api', () => ({
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  workspace: { getConfiguration: vi.fn(), rootPath: undefined },
  window: {},
}))

const p4deltaMocks = vi.hoisted(() => ({
  resolveP4deltaCommand:
    vi.fn<(configuredPath?: string, managedRoot?: string) => P4deltaCandidate | undefined>(),
  probeP4deltaBuild:
    vi.fn<(exe: string, timeoutMs?: number) => Promise<P4deltaVersion | undefined>>(),
}))
vi.mock('../p4delta/p4deltaService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../p4delta/p4deltaService.js')>()
  return {
    ...actual,
    resolveP4deltaCommand: (configuredPath?: string, managedRoot?: string) =>
      p4deltaMocks.resolveP4deltaCommand(configuredPath, managedRoot),
    probeP4deltaBuild: p4deltaMocks.probeP4deltaBuild,
  }
})

// The gate's existence check, and only that: a path in the set counts as
// present, every other reading stays the real `node:fs` — the modules
// extension.ts pulls in must not see a faked filesystem.
const fsState = vi.hoisted(() => ({ existing: new Set<string>() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      fsState.existing.has(String(path)) ? true : actual.existsSync(path),
  }
})

const p4Mocks = vi.hoisted(() => ({
  resolveP4Command: vi.fn<() => { command: string; prefixArgs: string[] }>(),
}))
vi.mock('../p4Service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../p4Service.js')>()
  return { ...actual, resolveP4Command: () => p4Mocks.resolveP4Command() }
})

const { createP4deltaVersionRefusalNotifier, resolveP4deltaEngine } =
  await import('../extension.js')

const EXE = process.platform === 'win32' ? 'C:/tools/p4delta.exe' : '/opt/p4delta'
const P4_SCRIPT = process.platform === 'win32' ? 'C:/e2e/fake-p4.mjs' : '/e2e/fake-p4.mjs'
const MANAGED_ROOT = process.platform === 'win32' ? 'C:/store/p4delta' : '/store/p4delta'
const MANAGED_EXE =
  process.platform === 'win32'
    ? 'C:/store/p4delta/0.1.10/p4delta.exe'
    : '/store/p4delta/0.1.10/p4delta.exe'
const REQUIRED = '0.1.19'

describe('resolveP4deltaEngine', () => {
  beforeEach(() => {
    delete process.env.UNIVERSE_P4DELTA_PATH
    fsState.existing.clear()
    p4deltaMocks.resolveP4deltaCommand.mockReset()
    p4deltaMocks.probeP4deltaBuild.mockReset().mockResolvedValue([0, 1, 19])
    p4Mocks.resolveP4Command.mockReset()
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'p4', prefixArgs: [] })
  })

  it('never resolves the binary when the engine is disabled', async () => {
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: false, path: EXE }, log)

    expect(engine).toBeUndefined()
    expect(p4deltaMocks.resolveP4deltaCommand).not.toHaveBeenCalled()
    expect(p4deltaMocks.probeP4deltaBuild).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disabled'))
  })

  it('skips the engine when p4 is a script override and δ was not named', async () => {
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'node', prefixArgs: [P4_SCRIPT] })
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log)

    expect(engine).toBeUndefined()
    expect(p4deltaMocks.resolveP4deltaCommand).not.toHaveBeenCalled()
    expect(p4deltaMocks.probeP4deltaBuild).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('script override'))
  })

  it('keeps the engine under a p4 script override when the δ path is configured', async () => {
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'node', prefixArgs: [P4_SCRIPT] })
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: EXE, source: 'path' })
    fsState.existing.add(EXE)
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: EXE }, log)

    // The engine must carry the pointer to THIS session's p4: δ resolves its own
    // `p4` when it needs to hand a file over, and under an override that lookup
    // would land on a different binary than the session runs against.
    expect(engine).toEqual({ exe: EXE, source: 'path', extraEnv: { P4_EXE: P4_SCRIPT } })
  })

  it('keeps the engine under a p4 script override when UNIVERSE_P4DELTA_PATH names it', async () => {
    process.env.UNIVERSE_P4DELTA_PATH = EXE
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'node', prefixArgs: [P4_SCRIPT] })
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: EXE, source: 'path' })
    fsState.existing.add(EXE)

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, vi.fn())

    expect(engine).toEqual({ exe: EXE, source: 'path', extraEnv: { P4_EXE: P4_SCRIPT } })
  })

  it('returns the resolved executable when the version is high enough', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: EXE, source: 'path' })
    fsState.existing.add(EXE)
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log)

    // A real p4 needs no pointer: δ's own lookup finds the same one, and forcing
    // P4_EXE would make it demand a file literally named `p4`.
    expect(engine).toEqual({ exe: EXE, source: 'path' })
    expect(p4deltaMocks.resolveP4deltaCommand).toHaveBeenCalledWith('', undefined)
    expect(p4deltaMocks.probeP4deltaBuild).toHaveBeenCalledWith(EXE)
    expect(log).toHaveBeenCalledWith(expect.stringContaining(EXE))
    expect(log).toHaveBeenCalledWith(expect.stringContaining(REQUIRED))
  })

  it('admits exactly the minimum and does not warn', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: EXE, source: 'path' })
    fsState.existing.add(EXE)
    p4deltaMocks.probeP4deltaBuild.mockResolvedValue([0, 1, 19])
    const refused = vi.fn()

    const engine = await resolveP4deltaEngine(
      { enabled: true, path: '' },
      vi.fn(),
      undefined,
      refused,
    )

    expect(engine).toEqual({ exe: EXE, source: 'path' })
    expect(refused).not.toHaveBeenCalled()
  })

  it('refuses a build below the minimum and reports it to the callback', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: EXE, source: 'path' })
    fsState.existing.add(EXE)
    p4deltaMocks.probeP4deltaBuild.mockResolvedValue([0, 1, 18])
    const log = vi.fn()
    const refused = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log, undefined, refused)

    expect(engine).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`older than the required ${REQUIRED}`))
    expect(refused).toHaveBeenCalledWith({
      exe: EXE,
      source: 'path',
      version: '0.1.18',
      required: REQUIRED,
    })
  })

  it('is fail-closed when the probe cannot read a version', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: EXE, source: 'path' })
    fsState.existing.add(EXE)
    p4deltaMocks.probeP4deltaBuild.mockResolvedValue(undefined)
    const log = vi.fn()
    const refused = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log, undefined, refused)

    expect(engine).toBeUndefined()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`did not report a supported version (>= ${REQUIRED})`),
    )
    expect(refused).toHaveBeenCalledWith({
      exe: EXE,
      source: 'path',
      version: undefined,
      required: REQUIRED,
    })
  })

  it('reports the managed source in the refusal', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: MANAGED_EXE, source: 'managed' })
    fsState.existing.add(MANAGED_EXE)
    p4deltaMocks.probeP4deltaBuild.mockResolvedValue([0, 1, 10])
    const refused = vi.fn()

    await resolveP4deltaEngine({ enabled: true, path: '' }, vi.fn(), MANAGED_ROOT, refused)

    expect(refused).toHaveBeenCalledWith({
      exe: MANAGED_EXE,
      source: 'managed',
      version: '0.1.10',
      required: REQUIRED,
    })
  })

  it('does not require the refusal callback', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: EXE, source: 'path' })
    fsState.existing.add(EXE)
    p4deltaMocks.probeP4deltaBuild.mockResolvedValue([0, 1, 18])

    await expect(
      resolveP4deltaEngine({ enabled: true, path: '' }, vi.fn()),
    ).resolves.toBeUndefined()
  })

  it('degrades to native when no executable can be found', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(undefined)
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log)

    expect(engine).toBeUndefined()
    expect(p4deltaMocks.probeP4deltaBuild).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not found'))
  })

  it('degrades to native when the resolved path is not there', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: EXE, source: 'path' })
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: EXE }, log)

    expect(engine).toBeUndefined()
    expect(p4deltaMocks.probeP4deltaBuild).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not found'))
  })

  it('hands the managed root to the resolver and admits what it answers', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: MANAGED_EXE, source: 'managed' })
    fsState.existing.add(MANAGED_EXE)
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log, MANAGED_ROOT)

    expect(engine).toEqual({ exe: MANAGED_EXE, source: 'managed' })
    expect(p4deltaMocks.resolveP4deltaCommand).toHaveBeenCalledWith('', MANAGED_ROOT)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(managed,'))
  })

  it('degrades to native when the managed copy is gone between resolution and admission', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue({ exe: MANAGED_EXE, source: 'managed' })
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log, MANAGED_ROOT)

    expect(engine).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not found'))
  })

  it('disables the managed tier entirely without a root', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(undefined)

    await expect(
      resolveP4deltaEngine({ enabled: true, path: '' }, vi.fn()),
    ).resolves.toBeUndefined()
    expect(p4deltaMocks.resolveP4deltaCommand).toHaveBeenCalledWith('', undefined)
  })
})

describe('createP4deltaVersionRefusalNotifier', () => {
  const info = {
    exe: EXE,
    source: 'path' as const,
    version: '0.1.18',
    required: REQUIRED,
  }

  it('warns once per exe and version', () => {
    const warn = vi.fn()
    const notify = createP4deltaVersionRefusalNotifier(warn)

    notify(info)
    notify(info)
    notify({ ...info, version: '0.1.17' })
    notify({ ...info, exe: `${EXE}2` })

    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('names the found version, path and requirement', () => {
    const warn = vi.fn()
    createP4deltaVersionRefusalNotifier(warn)(info)

    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('0.1.18')
    expect(message).toContain(EXE)
    expect(message).toContain(REQUIRED)
    expect(message).toContain('perforce.p4delta.path')
    expect(typeof warn.mock.calls[0]?.[1]).toBe('string')
  })

  it('explains an unreadable version without claiming it is older', () => {
    const warn = vi.fn()
    createP4deltaVersionRefusalNotifier(warn)({ ...info, version: undefined })

    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('did not report a usable version')
    expect(message).toContain(REQUIRED)
    expect(message).not.toContain('older than')
  })

  it('swallows a throwing warn callback', () => {
    const notify = createP4deltaVersionRefusalNotifier(() => {
      throw new Error('no host here')
    })

    expect(() => notify(info)).not.toThrow()
  })
})
