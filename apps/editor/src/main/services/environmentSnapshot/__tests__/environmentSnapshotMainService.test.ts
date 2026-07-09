/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/environmentSnapshot/environmentSnapshotMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { EnvironmentSnapshotMainService } from '../environmentSnapshotMainService.js'

describe('EnvironmentSnapshotMainService', () => {
  it('returns home / cwd / env from the injected sources', async () => {
    const service = new EnvironmentSnapshotMainService({
      env: { FOO: 'bar', PATH: '/usr/bin' },
      cwd: () => '/work/dir',
      userHome: () => '/home/user',
    })

    const snap = await service.getSnapshot()

    expect(snap.userHome).toBe('/home/user')
    expect(snap.cwd).toBe('/work/dir')
    expect(snap.env).toEqual({ FOO: 'bar', PATH: '/usr/bin' })
  })

  it('drops undefined env entries', async () => {
    const service = new EnvironmentSnapshotMainService({
      env: { A: 'x', B: undefined },
      cwd: () => '/',
      userHome: () => '/',
    })

    const snap = await service.getSnapshot()

    expect(snap.env).toEqual({ A: 'x' })
    expect('B' in snap.env).toBe(false)
  })
})
