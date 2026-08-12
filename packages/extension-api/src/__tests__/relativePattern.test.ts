/**
 * Tests for `RelativePattern`: the three accepted base forms (string path,
 * `Uri`, `WorkspaceFolder`-shaped object) and the JSON shape the host
 * serializes onto the wire.
 */
import { describe, expect, it } from 'vitest'
import { RelativePattern } from '../relativePattern.js'
import { Uri } from '../uri.js'

const isWindows = process.platform === 'win32'
const expectedFsPath = isWindows ? '\\ws\\src' : '/ws/src'

describe('RelativePattern', () => {
  it('takes a plain string base unchanged', () => {
    const rp = new RelativePattern('/ws/src', '**/*.ts')
    expect(rp.base).toBe('/ws/src')
    expect(rp.pattern).toBe('**/*.ts')
  })

  it('takes a Uri base via its fsPath', () => {
    const rp = new RelativePattern(Uri.file('/ws/src'), '*.ts')
    expect(rp.base).toBe(expectedFsPath)
    expect(rp.pattern).toBe('*.ts')
  })

  it('takes a WorkspaceFolder-shaped base via its uri', () => {
    const folder = { uri: Uri.file('/ws/src'), name: 'src', index: 0 }
    const rp = new RelativePattern(folder, '*.ts')
    expect(rp.base).toBe(expectedFsPath)
  })

  it('serializes onto the wire as a file: UriComponents base plus the pattern', () => {
    const rp = new RelativePattern('/ws/src', '**/*.ts')
    expect({ base: Uri.file(rp.base).toJSON(), pattern: rp.pattern }).toEqual({
      base: { scheme: 'file', path: '/ws/src' },
      pattern: '**/*.ts',
    })
  })
})
