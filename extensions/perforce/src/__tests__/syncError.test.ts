import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifySyncError } from '../p4Error.js'
import { localize } from '../nls.js'
import type { P4ExecResult } from '../p4Service.js'

const result = (stderr = '', stdout = ''): P4ExecResult => ({ stdout, stderr, exitCode: 1 })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('classifySyncError', () => {
  it('classifies can’t clobber writable file as clobber', () => {
    const r = classifySyncError(
      result("Perforce client error:\n\tCan't clobber writable file X:/p4ws/main/a.cpp"),
    )
    expect(r.kind).toBe('clobber')
    expect(r.suggestion).toBe(
      localize(
        'perforce.error.clobber',
        'The file has uncollected local changes. Force-syncing would overwrite them (those changes would be lost) — collect the changes first if you want to keep them.',
      ),
    )
  })

  it('classifies must resolve as mustResolve', () => {
    expect(classifySyncError(result('must resolve #4 before submitting')).kind).toBe('mustResolve')
    expect(classifySyncError(result('must be resolved before submitting')).kind).toBe('mustResolve')
  })

  it('classifies file(s) up-to-date as upToDate', () => {
    const r = classifySyncError(result('X:/p4ws/main/... - file(s) up-to-date.'))
    expect(r.kind).toBe('upToDate')
    expect(r.suggestion).toBe(localize('perforce.error.upToDate', 'File(s) already up to date.'))
  })

  it('classifies no such file(s) / not in client view as noSuchFile', () => {
    expect(classifySyncError(result('X:/p4ws/main/x.txt - no such file(s).')).kind).toBe(
      'noSuchFile',
    )
    expect(
      classifySyncError(result('//depot/branch_x/x.txt - file(s) not in client view.')).kind,
    ).toBe('noSuchFile')
  })

  it('falls back to other with the raw p4 text as suggestion', () => {
    const r = classifySyncError(result('Perforce client error: some other failure'))
    expect(r.kind).toBe('other')
    expect(r.suggestion).toBe('Perforce client error: some other failure')
  })

  it('matches stderr or stdout, case-insensitively', () => {
    expect(
      classifySyncError(result('', "Can't Clobber Writable File X:/p4ws/main/a.cpp")).kind,
    ).toBe('clobber')
    expect(classifySyncError(result('MUST RESOLVE #4 before submitting')).kind).toBe('mustResolve')
  })
})

describe('classifySyncError (Chinese surface)', () => {
  it('surfaces the Chinese guidance when the display locale is Chinese', async () => {
    vi.stubEnv('UNIVERSE_DISPLAY_LOCALE', 'zh-cn')
    vi.resetModules()
    const zh = await import('../p4Error.js')
    expect(
      zh.classifySyncError(result("can't clobber writable file X:/p4ws/main/a.cpp")).suggestion,
    ).toContain('未收集的本地修改')
    expect(zh.classifySyncError(result('must resolve #4 before submitting')).suggestion).toContain(
      '解决冲突',
    )
    expect(zh.classifySyncError(result('file(s) up-to-date.')).suggestion).toBe('已是最新版本')
    expect(zh.classifySyncError(result('no such file(s).')).suggestion).toContain('client 视图')
  })
})
