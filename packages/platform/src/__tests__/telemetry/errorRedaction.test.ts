/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/telemetry/errorRedaction.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { redactErrorText } from '../../telemetry/errorRedaction.js'

describe('redactErrorText — piiPaths', () => {
  it('masks known paths including the forward-slash variant', () => {
    const text =
      'at f (C:\\Users\\testuser\\project\\src\\a.ts:1:1) and C:/Users/testuser/project/src/b.ts:2:2'
    const out = redactErrorText(text, { piiPaths: ['C:\\Users\\testuser\\project'] })
    expect(out).not.toContain('testuser')
    expect(out).toContain('<pii>')
  })

  it('prefers the longest path first', () => {
    const text = 'inside /home/ci/work/repo/sub/file.ts:1:1'
    const out = redactErrorText(text, { piiPaths: ['/home/ci/work', '/home/ci/work/repo'] })
    expect(out).toContain('<pii>')
    expect(out).not.toContain('ci')
  })
})

describe('redactErrorText — path anonymization', () => {
  it('masks OS user directories', () => {
    expect(redactErrorText('at f (C:\\Users\\alice\\x\\f.ts:1:1)')).not.toContain('alice')
    expect(redactErrorText('at f (/Users/bob/x/f.ts:1:1)')).not.toContain('bob')
    expect(redactErrorText('at f (/home/carol/x/f.ts:1:1)')).not.toContain('carol')
  })

  it('keeps node_modules tails for attribution', () => {
    const out = redactErrorText(
      'at f (C:\\ci\\agent\\work\\node_modules\\some-pkg\\lib\\index.js:10:5)',
    )
    expect(out).toContain('node_modules')
    expect(out).toContain('some-pkg')
    expect(out).not.toContain('ci\\agent')
  })

  it('masks generic absolute paths', () => {
    const out = redactErrorText("ENOENT: open 'D:\\secret\\dir\\file.txt' failed")
    expect(out).not.toContain('secret')
    expect(out).toContain('<path>')
  })
})

describe('redactErrorText — secrets', () => {
  it('scrubs JWTs', () => {
    const out = redactErrorText(
      'auth failed: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    )
    expect(out).toContain('<secret>')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('scrubs api keys and github tokens', () => {
    expect(redactErrorText('key sk-abcdefghijklmnopqrstuvwxyz0123456789 rejected')).toContain(
      '<secret>',
    )
    expect(redactErrorText('token ghp_abcdefghijklmnopqrstuvwxyz012345 expired')).toContain(
      '<secret>',
    )
    expect(
      redactErrorText('token github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789 expired'),
    ).toContain('<secret>')
  })

  it('scrubs bearer headers and key=value credentials but keeps the key name', () => {
    const out = redactErrorText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')
    expect(out).toContain('<secret>')
    const kv = redactErrorText('config apiKey: "sk_live_abcdef1234567890" invalid')
    expect(kv).toContain('apiKey')
    expect(kv).not.toContain('sk_live_abcdef1234567890')
  })

  it('scrubs line-by-line so a secret on one line never eats the stack', () => {
    const text = [
      'Error: auth failed with sk-abcdefghijklmnopqrstuvwxyz0123456789',
      '    at send (C:\\app\\src\\net\\client.ts:30:4)',
    ].join('\n')
    const out = redactErrorText(text)
    expect(out).toContain('at send')
  })
})

describe('redactErrorText — length cap', () => {
  it('caps output at maxLength', () => {
    const out = redactErrorText('x'.repeat(20000), { maxLength: 100 })
    expect(out.length).toBeLessThanOrEqual(101) // 100 + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })

  it('defaults to the 8192 cap', () => {
    const out = redactErrorText('y'.repeat(20000))
    expect(out.length).toBeLessThanOrEqual(8193)
  })
})
