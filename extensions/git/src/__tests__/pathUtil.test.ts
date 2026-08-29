import { describe, expect, it, vi } from 'vitest'
import { isSubPath, norm, samePath } from '../pathUtil.js'

/** Run a body as if on the given platform; `process.platform` is read at call time. */
function onPlatform(platform: NodeJS.Platform, body: () => void): void {
  const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  try {
    body()
  } finally {
    spy.mockRestore()
  }
}

describe('norm', () => {
  it('unifies separators, strips trailing slashes and lower-cases the drive letter', () => {
    expect(norm('C:\\repo\\sub\\')).toBe('c:/repo/sub')
    expect(norm('/repo/sub//')).toBe('/repo/sub')
  })
})

describe('samePath', () => {
  it('matches paths differing only in separators or trailing slash', () => {
    expect(samePath('/repo/sub/', '/repo/sub')).toBe(true)
    expect(samePath('C:\\repo', 'c:/repo')).toBe(true)
  })

  it('distinguishes different directories', () => {
    expect(samePath('/repo/a', '/repo/b')).toBe(false)
  })

  it('folds case on Windows only', () => {
    onPlatform('win32', () => expect(samePath('C:/Repo/Sub', 'c:/repo/sub')).toBe(true))
    onPlatform('linux', () => expect(samePath('/Repo/Sub', '/repo/sub')).toBe(false))
  })
})

describe('isSubPath', () => {
  it('accepts a strict descendant and rejects the directory itself', () => {
    expect(isSubPath('/repo', '/repo/vendor/lib')).toBe(true)
    expect(isSubPath('/repo', '/repo')).toBe(false)
  })

  it('rejects a sibling sharing the same name prefix', () => {
    // `<repo>.worktrees/<name>` sits next to the repo, not inside it.
    expect(isSubPath('/repo', '/repo.worktrees/feature')).toBe(false)
  })

  it('folds case on Windows only', () => {
    onPlatform('win32', () => expect(isSubPath('C:/Repo', 'c:/repo/vendor')).toBe(true))
    onPlatform('linux', () => expect(isSubPath('/Repo', '/repo/vendor')).toBe(false))
  })
})
