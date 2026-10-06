/**
 * The δ engine gate in `activate`: `resolveP4deltaEngine` is the ONE decision
 * helper both client construction points share, so its rules are pinned here.
 *  1. `perforce.p4delta.enabled: false` must not even RESOLVE the binary — no
 *     path lookup, no filesystem check.
 *  2. A `p4` script override (the e2e fake) keeps the session native UNLESS the
 *     operator named δ too (the env override or the setting) — that is the e2e
 *     fixture's "both engines are mine" case, and there δ must go out carrying
 *     `P4_EXE` so its hand-offs reach the same fake p4.
 *  3. A missing executable (nothing resolved, or a resolved path that is not
 *     there) degrades to native with a log line — never an error dialog, never a
 *     throw. The binary itself is taken as capable of the whole surface the
 *     extension drives: there is no version gate.
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
}))
vi.mock('../p4deltaService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../p4deltaService.js')>()
  return {
    ...actual,
    resolveP4deltaCommand: (configuredPath?: string) =>
      p4deltaMocks.resolveP4deltaCommand(configuredPath),
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

const { resolveP4deltaEngine } = await import('../extension.js')

const EXE = process.platform === 'win32' ? 'C:/tools/p4delta.exe' : '/opt/p4delta'
const P4_SCRIPT = process.platform === 'win32' ? 'C:/e2e/fake-p4.mjs' : '/e2e/fake-p4.mjs'

describe('resolveP4deltaEngine', () => {
  beforeEach(() => {
    delete process.env.UNIVERSE_P4DELTA_PATH
    fsState.existing.clear()
    p4deltaMocks.resolveP4deltaCommand.mockReset()
    p4Mocks.resolveP4Command.mockReset()
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'p4', prefixArgs: [] })
  })

  it('never resolves the binary when the engine is disabled', () => {
    const log = vi.fn()

    const engine = resolveP4deltaEngine({ enabled: false, path: EXE }, log)

    expect(engine).toBeUndefined()
    expect(p4deltaMocks.resolveP4deltaCommand).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disabled'))
  })

  it('skips the engine when p4 is a script override and δ was not named', () => {
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'node', prefixArgs: [P4_SCRIPT] })
    const log = vi.fn()

    const engine = resolveP4deltaEngine({ enabled: true, path: '' }, log)

    expect(engine).toBeUndefined()
    expect(p4deltaMocks.resolveP4deltaCommand).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('script override'))
  })

  it('keeps the engine under a p4 script override when the δ path is configured', () => {
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'node', prefixArgs: [P4_SCRIPT] })
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(EXE)
    fsState.existing.add(EXE)
    const log = vi.fn()

    const engine = resolveP4deltaEngine({ enabled: true, path: EXE }, log)

    // The engine must carry the pointer to THIS session's p4: δ resolves its own
    // `p4` when it needs to hand a file over, and under an override that lookup
    // would land on a different binary than the session runs against.
    expect(engine).toEqual({ exe: EXE, extraEnv: { P4_EXE: P4_SCRIPT } })
  })

  it('keeps the engine under a p4 script override when UNIVERSE_P4DELTA_PATH names it', () => {
    process.env.UNIVERSE_P4DELTA_PATH = EXE
    p4Mocks.resolveP4Command.mockReturnValue({ command: 'node', prefixArgs: [P4_SCRIPT] })
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(EXE)
    fsState.existing.add(EXE)

    const engine = resolveP4deltaEngine({ enabled: true, path: '' }, vi.fn())

    expect(engine).toEqual({ exe: EXE, extraEnv: { P4_EXE: P4_SCRIPT } })
  })

  it('returns the resolved executable', () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(EXE)
    fsState.existing.add(EXE)
    const log = vi.fn()

    const engine = resolveP4deltaEngine({ enabled: true, path: '' }, log)

    // A real p4 needs no pointer: δ's own lookup finds the same one, and forcing
    // P4_EXE would make it demand a file literally named `p4`.
    expect(engine).toEqual({ exe: EXE })
    expect(p4deltaMocks.resolveP4deltaCommand).toHaveBeenCalledWith('')
    expect(log).toHaveBeenCalledWith(expect.stringContaining(EXE))
  })

  it('degrades to native when no executable can be found', () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(undefined)
    const log = vi.fn()

    const engine = resolveP4deltaEngine({ enabled: true, path: '' }, log)

    expect(engine).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not found'))
  })

  // The whole admission test, now that no version gate exists: the file has to
  // be there. Nothing about the binary is sampled.
  it('degrades to native when the resolved path is not there', () => {
    p4deltaMocks.resolveP4deltaCommand.mockReturnValue(EXE)
    const log = vi.fn()

    const engine = resolveP4deltaEngine({ enabled: true, path: EXE }, log)

    expect(engine).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not found'))
  })
})
