/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/process/env.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { buildChildEnv, CHILD_ENV_DENYLIST } from '../env.js'

describe('buildChildEnv', () => {
  it('strips every denylisted variable from the base', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/bin', HOME: '/home/u' }
    for (const k of CHILD_ENV_DENYLIST) base[k] = 'leak'
    const out = buildChildEnv(base)
    expect(out.PATH).toBe('/bin')
    expect(out.HOME).toBe('/home/u')
    for (const k of CHILD_ENV_DENYLIST) expect(out[k]).toBeUndefined()
  })

  it('merges overrides on top of the base but still filters the denylist', () => {
    const out = buildChildEnv(
      { PATH: '/bin' },
      { overrides: { FOO: 'bar', NODE_OPTIONS: '--inspect' } },
    )
    expect(out.FOO).toBe('bar')
    expect(out.NODE_OPTIONS).toBeUndefined()
  })

  it('re-adds ELECTRON_RUN_AS_NODE only when runAsNode is set', () => {
    expect(buildChildEnv({}).ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(buildChildEnv({}, { runAsNode: true }).ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('runAsNode wins even if the base carried a stripped flag', () => {
    const out = buildChildEnv({ ELECTRON_RUN_AS_NODE: '0' }, { runAsNode: true })
    expect(out.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
