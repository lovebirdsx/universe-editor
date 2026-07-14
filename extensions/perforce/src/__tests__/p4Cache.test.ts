import { describe, expect, it } from 'vitest'
import {
  P4Cache,
  P4CacheNs,
  registerP4CacheNamespaces,
  type P4CacheDiskBackend,
} from '../p4Cache.js'

/** A clock whose value tests advance by hand. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000
  return { now: () => t, advance: (ms) => (t += ms) }
}

/** In-memory disk backend spy. */
function fakeDisk(): P4CacheDiskBackend & { store: Map<string, string>; reads: number } {
  const store = new Map<string, string>()
  const self = {
    store,
    reads: 0,
    get(ns: string, key: string): string | undefined {
      self.reads++
      return store.get(`${ns}/${key}`)
    },
    set(ns: string, key: string, value: string): void {
      store.set(`${ns}/${key}`, value)
    },
  }
  return self
}

describe('P4Cache', () => {
  it('serves a second read from cache (no second fetch)', async () => {
    const cache = new P4Cache()
    cache.register('ns', { kind: 'immutable' })
    let fetches = 0
    const fetch = async () => {
      fetches++
      return 'v'
    }
    expect(await cache.wrap('ns', 'k', fetch)).toBe('v')
    expect(await cache.wrap('ns', 'k', fetch)).toBe('v')
    expect(fetches).toBe(1)
  })

  it('does not cache an undefined (failed) fetch', async () => {
    const cache = new P4Cache()
    cache.register('ns', { kind: 'ttl', ttlMs: 1000 })
    let fetches = 0
    const fail = async () => {
      fetches++
      return undefined
    }
    expect(await cache.wrap('ns', 'k', fail)).toBeUndefined()
    expect(await cache.wrap('ns', 'k', fail)).toBeUndefined()
    expect(fetches).toBe(2)
  })

  it('coalesces concurrent reads for the same key', async () => {
    const cache = new P4Cache()
    cache.register('ns', { kind: 'ttl', ttlMs: 1000 })
    let resolve: ((value: string) => void) | undefined
    let fetches = 0
    const fetch = () => {
      fetches++
      return new Promise<string>((r) => (resolve = r))
    }

    const first = cache.wrap('ns', 'k', fetch)
    const second = cache.wrap('ns', 'k', fetch)
    expect(fetches).toBe(1)
    resolve?.('value')

    await expect(Promise.all([first, second])).resolves.toEqual(['value', 'value'])
  })

  it('does not let an invalidated in-flight read repopulate stale data', async () => {
    const cache = new P4Cache()
    cache.register('ns', { kind: 'ttl', ttlMs: 1000 })
    let resolveStale: ((value: string) => void) | undefined
    const stale = cache.wrap(
      'ns',
      'k',
      () => new Promise<string>((resolve) => (resolveStale = resolve)),
    )

    cache.invalidate('ns', 'k')
    await expect(cache.wrap('ns', 'k', async () => 'fresh')).resolves.toBe('fresh')
    resolveStale?.('stale')
    await expect(stale).resolves.toBe('stale')
    await expect(cache.wrap('ns', 'k', async () => 'wrong')).resolves.toBe('fresh')
  })

  it('invalidates one namespace without dropping another', async () => {
    const cache = new P4Cache()
    cache.register('a', { kind: 'ttl', ttlMs: 1000 })
    cache.register('b', { kind: 'ttl', ttlMs: 1000 })
    await cache.wrap('a', 'k', async () => 'a1')
    await cache.wrap('b', 'k', async () => 'b1')

    cache.invalidateNamespace('a')

    await expect(cache.wrap('a', 'k', async () => 'a2')).resolves.toBe('a2')
    await expect(cache.wrap('b', 'k', async () => 'b2')).resolves.toBe('b1')
  })

  it('expires a ttl entry after its window', async () => {
    const clock = fakeClock()
    const cache = new P4Cache(clock.now)
    cache.register('ns', { kind: 'ttl', ttlMs: 1000 })
    let fetches = 0
    const fetch = async () => `v${++fetches}`
    expect(await cache.wrap('ns', 'k', fetch)).toBe('v1')
    clock.advance(999)
    expect(await cache.wrap('ns', 'k', fetch)).toBe('v1') // still valid
    clock.advance(2)
    expect(await cache.wrap('ns', 'k', fetch)).toBe('v2') // expired → refetch
  })

  it('immutable entries never expire', async () => {
    const clock = fakeClock()
    const cache = new P4Cache(clock.now)
    cache.register('ns', { kind: 'immutable' })
    let fetches = 0
    const fetch = async () => `v${++fetches}`
    expect(await cache.wrap('ns', 'k', fetch)).toBe('v1')
    clock.advance(10_000_000)
    expect(await cache.wrap('ns', 'k', fetch)).toBe('v1')
    expect(fetches).toBe(1)
  })

  it('invalidateWorkspace drops ttl entries but keeps immutable ones', async () => {
    const cache = new P4Cache()
    cache.register('mut', { kind: 'ttl', ttlMs: 100_000 })
    cache.register('imm', { kind: 'immutable' })
    let mutFetches = 0
    let immFetches = 0
    await cache.wrap('mut', 'k', async () => `m${++mutFetches}`)
    await cache.wrap('imm', 'k', async () => `i${++immFetches}`)
    cache.invalidateWorkspace()
    expect(await cache.wrap('mut', 'k', async () => `m${++mutFetches}`)).toBe('m2')
    expect(await cache.wrap('imm', 'k', async () => `i${++immFetches}`)).toBe('i1')
  })

  it('invalidateFile targets only matching ttl keys', async () => {
    const cache = new P4Cache()
    cache.register('mut', { kind: 'ttl', ttlMs: 100_000 })
    let a = 0
    let b = 0
    await cache.wrap('mut', '//depot/a.txt', async () => `a${++a}`)
    await cache.wrap('mut', '//depot/b.txt', async () => `b${++b}`)
    cache.invalidateFile('a.txt')
    expect(await cache.wrap('mut', '//depot/a.txt', async () => `a${++a}`)).toBe('a2')
    expect(await cache.wrap('mut', '//depot/b.txt', async () => `b${++b}`)).toBe('b1')
  })

  it('disabled cache always fetches', async () => {
    const cache = new P4Cache(Date.now, undefined, false)
    cache.register('ns', { kind: 'immutable' })
    let fetches = 0
    const fetch = async () => `v${++fetches}`
    await cache.wrap('ns', 'k', fetch)
    await cache.wrap('ns', 'k', fetch)
    expect(fetches).toBe(2)
  })

  it('throws on an unregistered namespace', async () => {
    const cache = new P4Cache()
    await expect(cache.wrap('nope', 'k', async () => 'v')).rejects.toThrow(/unknown namespace/)
  })

  it('immutable writes go to disk and a cold cache reads them back', async () => {
    const disk = fakeDisk()
    // First cache instance: fetch + persist.
    const c1 = new P4Cache(Date.now, disk)
    c1.register('imm', { kind: 'immutable' })
    let fetches = 0
    await c1.wrap('imm', 'k', async () => `v${++fetches}`)
    expect(disk.store.get('imm/k')).toBe('v1')

    // Second (cold) cache instance sharing the same disk: served from disk.
    const c2 = new P4Cache(Date.now, disk)
    c2.register('imm', { kind: 'immutable' })
    expect(await c2.wrap('imm', 'k', async () => `v${++fetches}`)).toBe('v1')
    expect(fetches).toBe(1) // no new fetch
  })

  it('ttl namespaces are never persisted to disk', async () => {
    const disk = fakeDisk()
    const cache = new P4Cache(Date.now, disk)
    cache.register('mut', { kind: 'ttl', ttlMs: 1000 })
    await cache.wrap('mut', 'k', async () => 'v')
    expect(disk.store.size).toBe(0)
  })

  it('an immutable namespace with persist:false caches in memory but never touches disk', async () => {
    const disk = fakeDisk()
    const cache = new P4Cache(Date.now, disk)
    cache.register('imm', { kind: 'immutable', persist: false })
    let fetches = 0
    // Cached in memory: a second read is a hit (no refetch).
    expect(await cache.wrap('imm', 'k', async () => `v${++fetches}`)).toBe('v1')
    expect(await cache.wrap('imm', 'k', async () => `v${++fetches}`)).toBe('v1')
    expect(fetches).toBe(1)
    // But nothing was written to disk.
    expect(disk.store.size).toBe(0)
  })
})

describe('registerP4CacheNamespaces', () => {
  it('registers all standard namespaces with sane policies', async () => {
    const cache = new P4Cache()
    registerP4CacheNamespaces(cache, 4000)
    // All should be usable without throwing (i.e. registered).
    for (const ns of Object.values(P4CacheNs)) {
      await expect(cache.wrap(ns, 'k', async () => 'v')).resolves.toBe('v')
    }
  })
})
