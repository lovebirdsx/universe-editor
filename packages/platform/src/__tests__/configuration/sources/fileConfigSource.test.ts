import { describe, expect, it } from 'vitest'
import { FileConfigSource } from '../../../configuration/sources/fileConfigSource.js'
import type { ConfigItem } from '../../../configuration/sources/configSource.js'

const item = (filePath: string): ConfigItem<'string'> => ({
  id: filePath,
  type: 'string',
  filePath,
})

describe('FileConfigSource', () => {
  it('reads a top-level field', () => {
    const s = new FileConfigSource({ updateUrl: 'http://server/' })
    expect(s.getRawValue(item('updateUrl'))).toBe('http://server/')
  })

  it('reads a nested dotted path', () => {
    const s = new FileConfigSource({ update: { url: 'http://nested/' } })
    expect(s.getRawValue(item('update.url'))).toBe('http://nested/')
  })

  it('returns undefined for missing fields', () => {
    const s = new FileConfigSource({})
    expect(s.getRawValue(item('updateUrl'))).toBeUndefined()
  })

  it('returns undefined when an intermediate segment is not an object', () => {
    const s = new FileConfigSource({ update: 'oops' })
    expect(s.getRawValue(item('update.url'))).toBeUndefined()
  })

  it('returns undefined for items without a filePath', () => {
    const s = new FileConfigSource({ x: 'y' })
    expect(s.getRawValue({ id: 'x', type: 'string' })).toBeUndefined()
  })
})
