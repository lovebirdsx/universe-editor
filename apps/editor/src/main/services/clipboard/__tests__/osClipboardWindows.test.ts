import { describe, expect, it } from 'vitest'
import {
  DROP_EFFECT_COPY,
  DROP_EFFECT_MOVE,
  FILE_DROP_READ_SCRIPT,
  FILE_DROP_WRITE_SCRIPT,
  buildFileDropPayloadJson,
  parseFileDropResultJson,
} from '../osClipboardWindows.js'

describe('PowerShell script templates', () => {
  it('are static text with no user-data interpolation hooks', () => {
    for (const script of [FILE_DROP_WRITE_SCRIPT, FILE_DROP_READ_SCRIPT]) {
      expect(typeof script).toBe('string')
      expect(script.length).toBeGreaterThan(0)
      // No string interpolation placeholders: user data never enters the script text.
      expect(script).not.toContain('${')
      expect(script).not.toContain('paths.join')
      expect(script).not.toContain('JsonPath}')
    }
  })

  it('declares params and never embeds a path list', () => {
    expect(FILE_DROP_WRITE_SCRIPT).toContain('param(')
    expect(FILE_DROP_WRITE_SCRIPT).toContain('$JsonPath')
    expect(FILE_DROP_WRITE_SCRIPT).toContain('$OutPath')
    expect(FILE_DROP_WRITE_SCRIPT).toContain('SetFileDropList')
    expect(FILE_DROP_WRITE_SCRIPT).toContain('SetDataObject')
    expect(FILE_DROP_READ_SCRIPT).toContain('GetFileDropList')
  })

  it('writes the Preferred DropEffect stream with the dropEffect from the payload JSON', () => {
    expect(FILE_DROP_WRITE_SCRIPT).toContain("SetData('Preferred DropEffect'")
    expect(FILE_DROP_WRITE_SCRIPT).toContain('$payload.dropEffect')
    expect(FILE_DROP_WRITE_SCRIPT).toContain('[BitConverter]::GetBytes([int]$payload.dropEffect)')
    expect(FILE_DROP_WRITE_SCRIPT).toContain('$stream.Write($bytes, 0, 4)')
  })

  it('rewinds the DropEffect stream before handing it to the DataObject', () => {
    // Consumers read from the stream's current position: leaving it at the end
    // would yield 0 bytes and silently degrade cut to copy.
    const write = FILE_DROP_WRITE_SCRIPT.indexOf('$stream.Write($bytes, 0, 4)')
    const seek = FILE_DROP_WRITE_SCRIPT.indexOf(
      '$stream.Seek(0, [System.IO.SeekOrigin]::Begin)',
      write,
    )
    const setData = FILE_DROP_WRITE_SCRIPT.indexOf("SetData('Preferred DropEffect'", write)
    expect(seek).toBeGreaterThan(write)
    expect(setData).toBeGreaterThan(seek)
  })

  it('reads the Preferred DropEffect stream and maps DROPEFFECT_MOVE to isCut', () => {
    expect(FILE_DROP_READ_SCRIPT).toContain("GetDataPresent('Preferred DropEffect')")
    expect(FILE_DROP_READ_SCRIPT).toContain('[BitConverter]::ToInt32($effectBytes, 0)')
    expect(FILE_DROP_READ_SCRIPT).toContain('-eq 2')
  })

  it('rewinds a seekable DropEffect stream before copying it', () => {
    expect(FILE_DROP_READ_SCRIPT).toContain('$effectStream.CanSeek')
    expect(FILE_DROP_READ_SCRIPT).toContain('$effectStream.Seek(0, [System.IO.SeekOrigin]::Begin)')
  })
})

describe('buildFileDropPayloadJson', () => {
  it('serializes paths with DROPEFFECT_MOVE for cut', () => {
    const json = buildFileDropPayloadJson(['C:\\a\\b.txt', 'C:\\c d\\e.txt'], true)
    expect(JSON.parse(json)).toEqual({
      paths: ['C:\\a\\b.txt', 'C:\\c d\\e.txt'],
      dropEffect: DROP_EFFECT_MOVE,
    })
  })

  it('serializes paths with DROPEFFECT_COPY for copy', () => {
    const json = buildFileDropPayloadJson(['C:\\a\\b.txt'], false)
    expect(JSON.parse(json)).toEqual({ paths: ['C:\\a\\b.txt'], dropEffect: DROP_EFFECT_COPY })
  })

  it('handles chinese characters, quotes and backslashes', () => {
    const paths = ['C:\\用户\\文档\\文件.txt', 'C:\\has"quote\\and\\back\\slash.txt']
    const parsed = JSON.parse(buildFileDropPayloadJson(paths, false)) as { paths: string[] }
    expect(parsed.paths).toEqual(paths)
  })

  it('never contains script content', () => {
    const json = buildFileDropPayloadJson(['Add-Type', 'SetDataObject'], false)
    expect(json).not.toContain('$')
    expect(json).not.toContain('param')
  })
})

describe('parseFileDropResultJson', () => {
  it('parses the read-script result with isCut', () => {
    expect(parseFileDropResultJson('{"paths":["C:\\\\a","C:\\\\b"],"isCut":true}')).toEqual({
      paths: ['C:\\a', 'C:\\b'],
      isCut: true,
    })
  })

  it('round-trips a cut payload', () => {
    const payload = buildFileDropPayloadJson(['C:\\a\\b.txt'], true)
    const result = parseFileDropResultJson(
      `{"paths":["C:\\\\a\\\\b.txt"],"isCut":${(JSON.parse(payload) as { dropEffect: number }).dropEffect === DROP_EFFECT_MOVE}}`,
    )
    expect(result).toEqual({ paths: ['C:\\a\\b.txt'], isCut: true })
  })

  it('defaults to copy when isCut is missing', () => {
    expect(parseFileDropResultJson('{"paths":["C:\\\\a"]}')).toEqual({
      paths: ['C:\\a'],
      isCut: false,
    })
  })

  it('parses an empty path list', () => {
    expect(parseFileDropResultJson('{"paths":[],"isCut":false}')).toEqual({
      paths: [],
      isCut: false,
    })
  })

  it('drops non-string path entries', () => {
    expect(parseFileDropResultJson('{"paths":["a", 3, null],"isCut":false}')).toEqual({
      paths: ['a'],
      isCut: false,
    })
  })

  it('returns undefined for malformed input', () => {
    expect(parseFileDropResultJson('')).toBeUndefined()
    expect(parseFileDropResultJson('not json')).toBeUndefined()
    expect(parseFileDropResultJson('["a","b"]')).toBeUndefined()
    expect(parseFileDropResultJson('{"paths":"a"}')).toBeUndefined()
    expect(parseFileDropResultJson('"just a string"')).toBeUndefined()
  })
})
