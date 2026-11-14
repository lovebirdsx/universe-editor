/*---------------------------------------------------------------------------------------------
 *  The orphan sweep must kill ONLY the pid it identified. `taskkill /T` there severed
 *  live agent tool commands whose wrapper shell had already lost its own parent
 *  (Git-Bash MSYS `exec` leaves exactly that shape) — see processLifecycle.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFileSync,
  execFile: vi.fn(),
  spawn: vi.fn(),
}))

import { defaultKillOrphanPid } from '../processLifecycle.js'

describe('defaultKillOrphanPid', () => {
  it.skipIf(process.platform !== 'win32')('never passes /T (subtree) to taskkill', () => {
    execFileSync.mockClear()
    defaultKillOrphanPid(4242)

    expect(execFileSync).toHaveBeenCalledTimes(1)
    const [command, args] = execFileSync.mock.calls[0] as [string, string[]]
    expect(command).toBe('taskkill')
    expect(args).toEqual(['/pid', '4242', '/F'])
    expect(args).not.toContain('/T')
  })
})
