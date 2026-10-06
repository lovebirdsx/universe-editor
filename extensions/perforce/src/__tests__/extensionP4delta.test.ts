/**
 * The δ engine gate in `activate`: `resolveP4deltaEngine` is the ONE decision
 * helper both client construction points share, so its rules are pinned here.
 *  1. `perforce.p4delta.enabled: false` must not even RESOLVE the binary — no
 *     path lookup, no `--version` probe spawn.
 *  2. A `p4` script override (the e2e fake) keeps the session native UNLESS the
 *     operator named δ too (the env override or the setting) — that is the e2e
 *     fixture's "both engines are mine" case, and there δ must go out carrying
 *     `P4_EXE` so its hand-offs reach the same fake p4.
 *  3. A missing executable and a rejected probe (a build older than the minimum)
 *     both degrade to native with a log line — never an error dialog, never a
 *     throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// extension.ts pulls in the whole extension surface at import time; stub the API
// so importing the gate helper doesn't require the real host (same shape as
// setActiveRepo.test.ts).
vi.mock('@universe-editor/extension-api', () => ({
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  workspace: { getConfiguration: vi.fn(), rootPath: undefined },
  window: {},
}))

const p4deltaMocks = vi.hoisted(() => ({
  resolveP4deltaCommand: vi.fn<(configuredPath?: string) => string | undefined>(),
  probeP4delta: vi.fn<(exe: string) => Promise<boolean>>(),
}))
vi.mock('../p4deltaService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../p4deltaService.js')>()
  return {
    ...actual,
    resolveP4deltaCommand: (configuredPath?: string) =>
      p4deltaMocks.resolveP4deltaCommand(configuredPath),
    probeP4delta: (exe: string) => p4deltaMocks.probeP4delta(exe),
  }
})

const p4Mocks = vi.hoisted(() => ({
  resolveP4Command: vi.fn<() => { command: string; prefixArgs: string[] }>(),
}))
vi.mock('../p4Service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../p4Service.js')>()
  return { ...actual, resolveP4Command: () => p4Mocks.resolveP4Command() }
})

const { resolveP4deltaEngine } = await import('../extension.js')

const EXE = process.platform === 'win32' ? 'C:/tools/p4delta.exe' : '/opt/p4delta'
const P4_SCRIPT = process.platform === 'win32' ? 'C:/e2e/fake-p4.mjs' : '/e2e/fake-p4.mjs'

describe('resolveP4deltaEngine', () => {
  beforeEach(() => {
    delete process.env.UNIVERSE_P4DELTA_PATH
    p4deltaMocks.resolveP4deltaCommand.mockReset()
    p4deltaMocks.probeP4delta.mockReset()
    p4Mocks.resolveP4Command.mockReset()
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'p4', prefixArgs: [] })
  })

  it('never resolves or probes the binary when the engine is disabled', async () => {
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: false, path: EXE }, log)

    expect(engine).toBeUndefined()
    expect(p4deltaMocks.resolveP4deltaCommand).not.toHaveBeenCalled()
    expect(p4deltaMocks.probeP4delta).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disabled'))
  })

  it('skips the engine when p4 is a script override and δ was not named', async () => {
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'node', prefixArgs: [P4_SCRIPT] })
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log)

    expect(engine).toBeUndefined()
    expect(p4deltaMocks.resolveP4deltaCommand).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('script override'))
  })

  it('keeps the engine under a p4 script override when the δ path is configured', async () => {
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'node', prefixArgs: [P4_SCRIPT] })
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(EXE)
    p4deltaMocks.probeP4delta.mockResolvedValue(true)
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: EXE }, log)

    // The engine must carry the pointer to THIS session's p4: δ resolves its own
    // `p4` when it needs to hand a file over, and under an override that lookup
    // would land on a different binary than the session runs against.
    expect(engine).toEqual({ exe: EXE, extraEnv: { P4_EXE: P4_SCRIPT } })
  })

  it('keeps the engine under a p4 script override when UNIVERSE_P4DELTA_PATH names it', async () => {
    process.env.UNIVERSE_P4DELTA_PATH = EXE
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'node', prefixArgs: [P4_SCRIPT] })
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(EXE)
    p4deltaMocks.probeP4delta.mockResolvedValue(true)

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, vi.fn())

    expect(engine).toEqual({ exe: EXE, extraEnv: { P4_EXE: P4_SCRIPT } })
  })

  it('returns the probed executable when the probe passes', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(EXE)
    p4deltaMocks.probeP4delta.mockResolvedValue(true)
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log)

    // A real p4 needs no pointer: δ's own lookup finds the same one, and forcing
    // P4_EXE would make it demand a file literally named `p4`.
    expect(engine).toEqual({ exe: EXE })
    expect(p4deltaMocks.resolveP4deltaCommand).toHaveBeenCalledWith('')
    expect(p4deltaMocks.probeP4delta).toHaveBeenCalledWith(EXE)
    expect(log).toHaveBeenCalledWith(expect.stringContaining(EXE))
  })

  it('degrades to native when no executable can be found', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(undefined)
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: '' }, log)

    expect(engine).toBeUndefined()
    expect(p4deltaMocks.probeP4delta).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not found'))
  })

  // The verdict a plain get's safety hangs on: a build below the minimum
  // predates the sync split, so its `--sync` IS the force repair — the whole
  // engine stays off (scans included), not just the get.
  it('degrades to native when the probe rejects the build as too old', async () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(EXE)
    p4deltaMocks.probeP4delta.mockResolvedValue(false)
    const log = vi.fn()

    const engine = await resolveP4deltaEngine({ enabled: true, path: EXE }, log)

    expect(engine).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('did not report a supported version'))
  })
})
