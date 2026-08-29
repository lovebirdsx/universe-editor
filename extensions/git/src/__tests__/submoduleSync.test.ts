import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExecResult } from '../gitService.js'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))

vi.mock('../gitService.js', () => ({ gitExec: execMock }))

import {
  hasSubmodules,
  SUBMODULE_UPDATE_ARGS,
  updateSubmodules,
  updateSubmodulesIfPresent,
} from '../submoduleSync.js'

const ok = (stdout = ''): GitExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string): GitExecResult => ({ stdout: '', stderr, exitCode: 1 })

describe('submoduleSync', () => {
  let dir: string

  beforeEach(async () => {
    execMock.mockReset()
    execMock.mockResolvedValue(ok())
    dir = await mkdtemp(join(tmpdir(), 'git-submodule-sync-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  describe('hasSubmodules', () => {
    it('is true when .gitmodules exists', async () => {
      await writeFile(join(dir, '.gitmodules'), '[submodule "x"]\n')
      expect(await hasSubmodules(dir)).toBe(true)
    })

    it('is false without .gitmodules', async () => {
      expect(await hasSubmodules(dir)).toBe(false)
    })

    it('is false for a directory that does not exist', async () => {
      expect(await hasSubmodules(join(dir, 'nope'))).toBe(false)
    })
  })

  describe('updateSubmodules', () => {
    it('runs the recursive init update in the given root', async () => {
      await updateSubmodules('/repo', undefined)
      expect(execMock).toHaveBeenCalledWith(SUBMODULE_UPDATE_ARGS, '/repo', undefined)
    })

    it('passes the git result through unchanged', async () => {
      execMock.mockResolvedValue(fail('fatal: no submodule mapping'))
      const res = await updateSubmodules('/repo', undefined)
      expect(res).toEqual(fail('fatal: no submodule mapping'))
    })
  })

  describe('updateSubmodulesIfPresent', () => {
    it('does not shell out when the repo has no submodules', async () => {
      const outcome = await updateSubmodulesIfPresent(dir, undefined)
      expect(outcome).toEqual({ ran: false })
      expect(execMock).not.toHaveBeenCalled()
    })

    it('runs and reports the result when .gitmodules is present', async () => {
      await writeFile(join(dir, '.gitmodules'), '[submodule "x"]\n')
      const outcome = await updateSubmodulesIfPresent(dir, undefined)

      expect(outcome).toEqual({ ran: true, result: ok() })
      expect(execMock).toHaveBeenCalledWith(SUBMODULE_UPDATE_ARGS, dir, undefined)
    })

    it('reports ran:true with the failing result so callers can surface it', async () => {
      await writeFile(join(dir, '.gitmodules'), '[submodule "x"]\n')
      execMock.mockResolvedValue(fail('fatal: submodule update failed'))
      const outcome = await updateSubmodulesIfPresent(dir, undefined)

      expect(outcome).toEqual({ ran: true, result: fail('fatal: submodule update failed') })
    })
  })
})
