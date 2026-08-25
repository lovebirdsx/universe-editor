import { describe, expect, it } from 'vitest'
import {
  encodeGnomeCopiedFiles,
  parseGnomeCopiedFiles,
  parseUriListText,
} from '../osClipboardLinux.js'

describe('encodeGnomeCopiedFiles', () => {
  it('encodes copy payloads', () => {
    expect(encodeGnomeCopiedFiles('copy', ['file:///a', 'file:///b'])).toBe(
      'copy\nfile:///a\nfile:///b',
    )
  })

  it('encodes cut payloads', () => {
    expect(encodeGnomeCopiedFiles('cut', ['file:///a'])).toBe('cut\nfile:///a')
  })
})

describe('parseGnomeCopiedFiles', () => {
  it('round-trips encode output', () => {
    const uris = ['file:///a', 'file:///b%20c', 'file:///中文 路径']
    const parsed = parseGnomeCopiedFiles(encodeGnomeCopiedFiles('copy', uris))
    expect(parsed).toEqual({ action: 'copy', uris })
  })

  it('parses the cut action', () => {
    expect(parseGnomeCopiedFiles('cut\nfile:///a')).toEqual({
      action: 'cut',
      uris: ['file:///a'],
    })
  })

  it('accepts LF, CR and CRLF separators', () => {
    expect(parseGnomeCopiedFiles('copy\nfile:///a\nfile:///b')).toEqual({
      action: 'copy',
      uris: ['file:///a', 'file:///b'],
    })
    expect(parseGnomeCopiedFiles('copy\r\nfile:///a\r\nfile:///b')).toEqual({
      action: 'copy',
      uris: ['file:///a', 'file:///b'],
    })
    expect(parseGnomeCopiedFiles('copy\rfile:///a\rfile:///b')).toEqual({
      action: 'copy',
      uris: ['file:///a', 'file:///b'],
    })
  })

  it('tolerates blank lines and surrounding whitespace', () => {
    expect(parseGnomeCopiedFiles('  copy  \n\nfile:///a\n\n')).toEqual({
      action: 'copy',
      uris: ['file:///a'],
    })
  })

  it('rejects malformed input', () => {
    expect(parseGnomeCopiedFiles('')).toBeUndefined()
    expect(parseGnomeCopiedFiles('copy')).toBeUndefined()
    expect(parseGnomeCopiedFiles('move\nfile:///a')).toBeUndefined()
    expect(parseGnomeCopiedFiles('file:///a\nfile:///b')).toBeUndefined()
  })
})

describe('parseUriListText', () => {
  it('skips blank lines and comments, splitting on any CR/LF combination', () => {
    expect(parseUriListText('# comment\r\nfile:///a\n\nfile:///b\rfile:///c')).toEqual([
      'file:///a',
      'file:///b',
      'file:///c',
    ])
  })

  it('returns an empty list for empty or comment-only input', () => {
    expect(parseUriListText('')).toEqual([])
    expect(parseUriListText('# only a comment')).toEqual([])
  })
})
