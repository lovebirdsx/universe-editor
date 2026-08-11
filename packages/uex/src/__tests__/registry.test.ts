import { describe, it, expect } from 'vitest'
import { resolveRegistry, resolveToken, normalizeRegistry } from '../lib/registry.js'
import { UexError } from '../errors.js'

describe('normalizeRegistry', () => {
  it('strips trailing slashes', () => {
    expect(normalizeRegistry('https://m.example.com/')).toBe('https://m.example.com')
    expect(normalizeRegistry('https://m.example.com///')).toBe('https://m.example.com')
  })
})

describe('resolveRegistry', () => {
  const config = {
    defaultRegistry: 'https://default.example.com',
    registries: { 'https://saved.example.com': { token: 't' } },
  }

  it('flag beats env beats config', () => {
    expect(resolveRegistry({ flag: 'https://flag.example.com/', env: {}, config })).toBe(
      'https://flag.example.com',
    )
    expect(
      resolveRegistry({ env: { UNIVERSE_GALLERY_URL: 'https://env.example.com/' }, config }),
    ).toBe('https://env.example.com')
    expect(resolveRegistry({ env: {}, config })).toBe('https://default.example.com')
  })

  it('falls back to a single saved bucket', () => {
    expect(
      resolveRegistry({ env: {}, config: { registries: { 'https://one.example.com': {} } } }),
    ).toBe('https://one.example.com')
  })

  it('throws with the three ways to fix it when unconfigured', () => {
    let err: unknown
    try {
      resolveRegistry({ env: {}, config: {} })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UexError)
    expect((err as UexError).hints).toHaveLength(3)
  })
})

describe('resolveToken', () => {
  const registry = 'https://m.example.com'
  const config = { registries: { [registry]: { token: 'uet_cfg' } } }

  it('env beats the config bucket', () => {
    expect(resolveToken({ env: { UNIVERSE_MARKET_TOKEN: 'uet_env' }, config, registry })).toBe(
      'uet_env',
    )
    expect(resolveToken({ env: {}, config, registry })).toBe('uet_cfg')
  })

  it('normalizes the registry key before lookup', () => {
    expect(resolveToken({ env: {}, config, registry: `${registry}/` })).toBe('uet_cfg')
  })

  it('throws when no token is available', () => {
    let err: unknown
    try {
      resolveToken({ env: {}, config: {}, registry })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UexError)
    expect((err as UexError).hints.join(' ')).toContain(`${registry}/gallery/register`)
  })
})
