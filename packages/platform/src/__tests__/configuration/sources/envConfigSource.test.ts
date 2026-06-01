import { describe, expect, it } from 'vitest'
import { EnvConfigSource } from '../../../configuration/sources/envConfigSource.js'
import type { ConfigItem } from '../../../configuration/sources/configSource.js'

const item = (env: string): ConfigItem<'string'> => ({ id: env, type: 'string', env })

describe('EnvConfigSource', () => {
  it('reads any env key, not just prefixed ones', () => {
    const s = new EnvConfigSource({ ELECTRON_RENDERER_URL: 'http://localhost:5173' })
    expect(s.getRawValue(item('ELECTRON_RENDERER_URL'))).toBe('http://localhost:5173')
  })

  it('returns undefined for missing keys', () => {
    const s = new EnvConfigSource({})
    expect(s.getRawValue(item('MISSING'))).toBeUndefined()
  })

  it('returns undefined for items without an env name', () => {
    const s = new EnvConfigSource({ X: 'y' })
    expect(s.getRawValue({ id: 'x', type: 'string' })).toBeUndefined()
  })
})
