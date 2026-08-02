import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EnvConfigSource } from '../../../configuration/sources/envConfigSource.js'
import type { ConfigItem } from '../../../configuration/sources/configSource.js'

const item = (env: string): ConfigItem<'string'> => ({ id: env, type: 'string', env })
const arrItem = (env: string): ConfigItem<'string[]'> => ({ id: env, type: 'string[]', env })

describe('EnvConfigSource', () => {
  it('reads any env key, not just prefixed ones', () => {
    const s = new EnvConfigSource({ ELECTRON_RENDERER_URL: 'http://localhost:5173' }, delimiter)
    expect(s.getRawValue(item('ELECTRON_RENDERER_URL'))).toBe('http://localhost:5173')
  })

  it('returns undefined for missing keys', () => {
    const s = new EnvConfigSource({}, delimiter)
    expect(s.getRawValue(item('MISSING'))).toBeUndefined()
  })

  it('returns undefined for items without an env name', () => {
    const s = new EnvConfigSource({ X: 'y' }, delimiter)
    expect(s.getRawValue({ id: 'x', type: 'string' })).toBeUndefined()
  })

  describe('string[] delimiter split', () => {
    it('splits a multi-value env on path.delimiter', () => {
      const s = new EnvConfigSource({ DEV_PATHS: ['a', 'b', 'c'].join(delimiter) }, delimiter)
      expect(s.getRawValue(arrItem('DEV_PATHS'))).toEqual(['a', 'b', 'c'])
    })

    it('wraps a single value in an array', () => {
      const s = new EnvConfigSource({ DEV_PATHS: 'only' }, delimiter)
      expect(s.getRawValue(arrItem('DEV_PATHS'))).toEqual(['only'])
    })

    it('drops empty segments and returns undefined when nothing remains', () => {
      const s = new EnvConfigSource({ DEV_PATHS: ['a', '', 'b'].join(delimiter) }, delimiter)
      expect(s.getRawValue(arrItem('DEV_PATHS'))).toEqual(['a', 'b'])
      const empty = new EnvConfigSource({ DEV_PATHS: '' }, delimiter)
      expect(empty.getRawValue(arrItem('DEV_PATHS'))).toBeUndefined()
    })
  })
})
