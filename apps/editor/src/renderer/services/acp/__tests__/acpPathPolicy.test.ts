/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpPathPolicy.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { AcpPathPolicy } from '../acpPathPolicy.js'

describe('AcpPathPolicy — posix', () => {
  const policy = new AcpPathPolicy({ platform: 'linux', home: '/home/alice' })

  it('accepts a file directly under the workspace root', () => {
    const d = policy.check('/work/proj', '/work/proj/src/index.ts')
    expect(d).toEqual({ ok: true, normalized: '/work/proj/src/index.ts' })
  })

  it('accepts the workspace root itself', () => {
    const d = policy.check('/work/proj', '/work/proj')
    expect(d.ok).toBe(true)
  })

  it('rejects relative paths', () => {
    const d = policy.check('/work/proj', 'src/index.ts')
    expect(d.ok).toBe(false)
  })

  it('rejects paths outside the workspace root', () => {
    const d = policy.check('/work/proj', '/etc/passwd')
    expect(d.ok).toBe(false)
  })

  it('rejects parent-directory traversal that escapes the workspace', () => {
    const d = policy.check('/work/proj', '/work/proj/../../etc/passwd')
    expect(d.ok).toBe(false)
  })

  it('normalizes ../ inside the workspace', () => {
    const d = policy.check('/work/proj', '/work/proj/src/../README.md')
    expect(d).toEqual({ ok: true, normalized: '/work/proj/README.md' })
  })

  it('rejects access into ~/.ssh', () => {
    const d = policy.check('/home/alice', '/home/alice/.ssh/id_rsa')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toMatch(/sensitive prefix/)
  })

  it('rejects denylisted filenames even inside cwd', () => {
    const d = policy.check('/work/proj', '/work/proj/.env')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toMatch(/denylisted/)
  })

  it('rejects NUL bytes', () => {
    const d = policy.check('/work/proj', '/work/proj/x\0.txt')
    expect(d.ok).toBe(false)
  })

  it('rejects UNC paths', () => {
    const d = policy.check('/work/proj', '//server/share/file')
    expect(d.ok).toBe(false)
  })

  it('rejects when cwd is empty', () => {
    const d = policy.check('', '/work/proj/x')
    expect(d.ok).toBe(false)
  })

  it('rejects when target is empty', () => {
    const d = policy.check('/work/proj', '')
    expect(d.ok).toBe(false)
  })

  it('case sensitive on linux', () => {
    const d = policy.check('/work/Proj', '/work/proj/file')
    expect(d.ok).toBe(false)
  })
})

describe('AcpPathPolicy — windows', () => {
  const policy = new AcpPathPolicy({
    platform: 'win32',
    home: 'C:\\Users\\alice',
  })

  it('accepts a file under a Windows workspace root', () => {
    const d = policy.check('C:\\work\\proj', 'C:\\work\\proj\\src\\index.ts')
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.normalized).toBe('C:/work/proj/src/index.ts')
  })

  it('case-insensitive on win32', () => {
    const d = policy.check('C:\\work\\Proj', 'C:\\WORK\\proj\\file.ts')
    expect(d.ok).toBe(true)
  })

  it('rejects when drive letter differs', () => {
    const d = policy.check('C:\\work', 'D:\\work\\file')
    expect(d.ok).toBe(false)
  })

  it('rejects sensitive prefix in user home', () => {
    const d = policy.check('C:\\Users\\alice', 'C:\\Users\\alice\\.ssh\\id_rsa')
    expect(d.ok).toBe(false)
  })

  it('rejects denylisted env file even via mixed slashes', () => {
    const d = policy.check('C:\\work', 'C:/work/.env.production')
    expect(d.ok).toBe(false)
  })

  it('rejects parent traversal escaping drive root', () => {
    const d = policy.check('C:\\work', 'C:\\work\\..\\..\\..\\Windows\\System32\\cmd.exe')
    expect(d.ok).toBe(false)
  })
})

describe('AcpPathPolicy — darwin', () => {
  const policy = new AcpPathPolicy({ platform: 'darwin', home: '/Users/alice' })

  it('case-insensitive on macOS', () => {
    const d = policy.check('/Users/Alice/code', '/users/alice/code/file.ts')
    expect(d.ok).toBe(true)
  })

  it('rejects ~/.aws', () => {
    const d = policy.check('/Users/alice', '/Users/alice/.aws/credentials')
    expect(d.ok).toBe(false)
  })
})
