import { describe, expect, it } from 'vitest'
import {
  ConfigResolver,
  type ConfigItem,
  type IConfigSource,
} from '../../../configuration/sources/configSource.js'

function source(
  name: string,
  values: Record<string, string | string[] | boolean | undefined>,
): IConfigSource {
  return {
    name,
    getRawValue: (item) => values[item.id],
  }
}

const STR: ConfigItem<'string'> = { id: 'k', type: 'string' }
const BOOL: ConfigItem<'boolean'> = { id: 'k', type: 'boolean' }
const ARR: ConfigItem<'string[]'> = { id: 'k', type: 'string[]' }

describe('ConfigResolver', () => {
  it('takes the highest-priority source that has a value', () => {
    const r = new ConfigResolver([
      source('cli', { k: 'from-cli' }),
      source('env', { k: 'from-env' }),
    ])
    expect(r.resolve(STR)).toEqual({ value: 'from-cli', origin: 'cli' })
  })

  it('falls through to a lower-priority source when higher ones are empty', () => {
    const r = new ConfigResolver([
      source('cli', { k: undefined }),
      source('env', { k: 'from-env' }),
    ])
    expect(r.resolve(STR)).toEqual({ value: 'from-env', origin: 'env' })
  })

  it('returns the default with origin "default" when no source matches', () => {
    const r = new ConfigResolver([source('cli', {}), source('env', {})])
    expect(r.resolve({ ...STR, default: 'fallback' })).toEqual({
      value: 'fallback',
      origin: 'default',
    })
  })

  it('skips a source whose value fails validation and continues', () => {
    const item: ConfigItem<'string'> = {
      id: 'k',
      type: 'string',
      validate: (v) => v.startsWith('http'),
    }
    const r = new ConfigResolver([
      source('cli', { k: 'not-a-url' }),
      source('env', { k: 'http://ok' }),
    ])
    expect(r.resolve(item)).toEqual({ value: 'http://ok', origin: 'env' })
  })

  it('normalizes boolean values', () => {
    expect(new ConfigResolver([source('env', { k: '1' })]).get(BOOL)).toBe(true)
    expect(new ConfigResolver([source('env', { k: 'true' })]).get(BOOL)).toBe(true)
    expect(new ConfigResolver([source('env', { k: '0' })]).get(BOOL)).toBe(false)
    expect(new ConfigResolver([source('env', { k: 'x' })]).get(BOOL)).toBe(false)
  })

  it('normalizes string[] values from a single string', () => {
    expect(new ConfigResolver([source('env', { k: 'one' })]).get(ARR)).toEqual(['one'])
    expect(new ConfigResolver([source('env', { k: ['a', 'b'] })]).get(ARR)).toEqual(['a', 'b'])
  })

  it('appendSource adds a lower-priority source', () => {
    const r = new ConfigResolver([source('cli', {})])
    r.appendSource(source('file', { k: 'from-file' }))
    expect(r.resolve(STR)).toEqual({ value: 'from-file', origin: 'file' })
  })
})
