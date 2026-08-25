import { describe, expect, it } from 'vitest'
import {
  buildNsfilenamesPlist,
  escapeXmlText,
  parseNsfilenamesPlist,
  unescapeXmlText,
} from '../osClipboardMac.js'

describe('buildNsfilenamesPlist', () => {
  it('builds a plist array of paths', () => {
    const plist = buildNsfilenamesPlist(['/Users/x/a.txt', '/tmp/b.txt'])
    expect(plist).toContain('<plist version="1.0">')
    expect(plist).toContain('<string>/Users/x/a.txt</string>')
    expect(plist).toContain('<string>/tmp/b.txt</string>')
  })

  it('escapes XML special characters in paths', () => {
    const plist = buildNsfilenamesPlist(['/a/&b<c>d.txt'])
    expect(plist).toContain('<string>/a/&amp;b&lt;c&gt;d.txt</string>')
    expect(plist).not.toContain('&b<c>d')
  })
})

describe('parseNsfilenamesPlist', () => {
  it('round-trips buildNsfilenamesPlist output', () => {
    const paths = ['/Users/x/a.txt', '/tmp/b.txt']
    expect(parseNsfilenamesPlist(buildNsfilenamesPlist(paths))).toEqual(paths)
  })

  it('unescapes entities on the way back', () => {
    const plist = buildNsfilenamesPlist(['/a/&b<c>d.txt'])
    expect(parseNsfilenamesPlist(plist)).toEqual(['/a/&b<c>d.txt'])
  })

  it('parses plists from other producers (formatting variations)', () => {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><array>',
      '<string>/a</string>',
      '<string>/b</string>',
      '</array></plist>',
    ].join('\n')
    expect(parseNsfilenamesPlist(plist)).toEqual(['/a', '/b'])
  })

  it('returns undefined when no <string> element exists', () => {
    expect(parseNsfilenamesPlist('<plist><array></array></plist>')).toBeUndefined()
    expect(parseNsfilenamesPlist('')).toBeUndefined()
  })
})

describe('escape/unescape round-trip', () => {
  it('handles all three entities', () => {
    expect(unescapeXmlText(escapeXmlText('a<b>&c>d'))).toBe('a<b>&c>d')
  })
})
