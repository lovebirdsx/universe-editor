import { afterEach, describe, expect, it } from 'vitest'
import { resolveP4Command } from '../p4Service.js'

const ORIGINAL = process.env.UNIVERSE_P4_PATH

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.UNIVERSE_P4_PATH
  else process.env.UNIVERSE_P4_PATH = ORIGINAL
})

describe('resolveP4Command', () => {
  it('defaults to `p4` from PATH when no override is set', () => {
    delete process.env.UNIVERSE_P4_PATH
    expect(resolveP4Command()).toEqual({ command: 'p4', prefixArgs: [] })
  })

  it('runs a .mjs override through the current Node runtime', () => {
    process.env.UNIVERSE_P4_PATH = '/tmp/fake-p4.mjs'
    const { command, prefixArgs } = resolveP4Command()
    expect(command).toBe(process.execPath)
    expect(prefixArgs).toEqual(['/tmp/fake-p4.mjs'])
  })

  it('runs .js / .cjs overrides through Node too', () => {
    for (const path of ['/tmp/fake.js', '/tmp/fake.cjs']) {
      process.env.UNIVERSE_P4_PATH = path
      expect(resolveP4Command()).toEqual({ command: process.execPath, prefixArgs: [path] })
    }
  })

  it('spawns a non-script override directly (a real p4 binary path)', () => {
    process.env.UNIVERSE_P4_PATH = '/opt/perforce/p4'
    expect(resolveP4Command()).toEqual({ command: '/opt/perforce/p4', prefixArgs: [] })
  })
})
