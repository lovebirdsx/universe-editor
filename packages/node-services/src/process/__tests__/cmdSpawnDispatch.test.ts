/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for packages/node-services/src/process/cmdSpawn.ts
 *
 *  The sibling cmdSpawn.test.ts asserts the built line and, on Windows, what
 *  cmd.exe makes of it. This file asserts what spawnViaCmd hands to node on
 *  *every* platform, because the input the rest of the repo depends on is the
 *  line itself: a bare command name that starts the line with `"` makes cmd
 *  take its `/s` path, strip the quotes, and lose the shim's `%~dp0` — the
 *  silent `code`/`npm`/`pnpm` failures those Windows tests cover. Keeping the
 *  line's shape pinned here means a re-quoting regression fails on every host.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnViaCmd } from '../cmdSpawn.js'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

const spawnMock = vi.mocked(spawn)

const lastCall = (): Parameters<typeof spawn> => {
  const call = spawnMock.mock.calls.at(-1)
  if (!call) throw new Error('spawn was not called')
  return call
}

/** The command line is the last argv entry — the only one cmd.exe parses. */
const lastCommandLine = (): string => {
  const line = lastCall()[1]?.at(-1)
  if (line === undefined) throw new Error('spawn got no command line')
  return line
}

describe('spawnViaCmd — what reaches node:child_process', () => {
  beforeEach(() => {
    spawnMock.mockClear()
  })

  it('spawns cmd.exe in its /d /s /c form with the pre-quoted line kept verbatim', () => {
    spawnViaCmd('code', ['-r', 'a b'])

    const [, argv, options] = lastCall()
    expect(argv).toEqual(['/d', '/s', '/c', 'code "-r" "a b"'])
    expect(options).toMatchObject({
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  })

  it('never starts the line with a quote for a name cmd can resolve from PATH', () => {
    for (const command of ['code', 'npx', 'pnpm.cmd', 'C:\\tools\\code.cmd', './tool']) {
      spawnViaCmd(command, ['--flag'])
      expect(lastCommandLine()).toBe(`${command} "--flag"`)
    }
  })

  it('honours COMSPEC and falls back to cmd.exe', () => {
    const saved = process.env['COMSPEC']
    try {
      process.env['COMSPEC'] = 'C:\\Windows\\System32\\cmd.exe'
      spawnViaCmd('code', [])
      expect(lastCall()[0]).toBe('C:\\Windows\\System32\\cmd.exe')

      delete process.env['COMSPEC']
      spawnViaCmd('code', [])
      expect(lastCall()[0]).toBe('cmd.exe')
    } finally {
      if (saved === undefined) delete process.env['COMSPEC']
      else process.env['COMSPEC'] = saved
    }
  })
})
