import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAllowedHosts, checkRequestHeaders, normalizeHostEntry } from '../requestSecurity.js'
import { contentTypeFor, isNoCacheAsset, resolveStaticPath } from '../staticAssets.js'

describe('buildAllowedHosts', () => {
  it('always accepts the bind host and loopback with the port', () => {
    expect(
      buildAllowedHosts({ bindHost: '192.0.2.10', port: 47321, extraHosts: [] }).sort(),
    ).toEqual(['127.0.0.1:47321', '192.0.2.10:47321', 'localhost:47321'])
  })

  it('accepts bare Tailscale host names with and without the port', () => {
    const allowed = buildAllowedHosts({
      bindHost: '127.0.0.1',
      port: 47321,
      extraHosts: ['https://PC.example.com/', 'pc2.example.com:8443'],
    })
    expect(allowed).toContain('pc.example.com')
    expect(allowed).toContain('pc.example.com:47321')
    expect(allowed).toContain('pc2.example.com:8443')
  })

  it('accepts the PC host name only with the port', () => {
    const allowed = buildAllowedHosts({
      bindHost: '192.0.2.10',
      port: 47321,
      localHostnames: ['Desktop-Test', 'desktop-test:1234'],
    })
    expect(allowed).toContain('desktop-test:47321')
    expect(allowed).not.toContain('desktop-test')
    expect(allowed).not.toContain('desktop-test:1234')
  })

  it('normalizes host entries', () => {
    expect(normalizeHostEntry('  PC.Example.COM ')).toBe('pc.example.com')
    expect(normalizeHostEntry('https://PC.example.com:8443/pair')).toBe('pc.example.com:8443')
    expect(normalizeHostEntry('')).toBeUndefined()
  })
})

describe('checkRequestHeaders', () => {
  const allowed = ['127.0.0.1:47321', 'pc.example.com']

  it('accepts an allowed host without an origin', () => {
    expect(checkRequestHeaders({ host: '127.0.0.1:47321', origin: undefined }, allowed)).toEqual({
      ok: true,
    })
  })

  it('accepts a same-origin request', () => {
    expect(
      checkRequestHeaders({ host: 'pc.example.com', origin: 'https://pc.example.com' }, allowed),
    ).toEqual({ ok: true })
  })

  it('rejects missing, unknown and rebound hosts', () => {
    expect(checkRequestHeaders({ host: undefined, origin: undefined }, allowed).ok).toBe(false)
    expect(checkRequestHeaders({ host: 'evil.example.com', origin: undefined }, allowed).ok).toBe(
      false,
    )
    expect(
      checkRequestHeaders({ host: 'pc.example.com:1234', origin: undefined }, allowed).ok,
    ).toBe(false)
  })

  it('rejects cross-origin and malformed origins', () => {
    expect(
      checkRequestHeaders({ host: 'pc.example.com', origin: 'https://evil.example.com' }, allowed)
        .ok,
    ).toBe(false)
    expect(checkRequestHeaders({ host: 'pc.example.com', origin: 'not a url' }, allowed).ok).toBe(
      false,
    )
    expect(checkRequestHeaders({ host: 'pc.example.com', origin: 'null' }, allowed).ok).toBe(false)
  })
})

describe('resolveStaticPath', () => {
  const root = join('/srv', 'mobile')

  it('resolves ordinary files under the root', () => {
    // resolveStaticPath absolutizes the root; join() would stay drive-relative on Windows.
    expect(resolveStaticPath(root, '/assets/app.js')).toEqual({
      kind: 'file',
      path: resolve(root, 'assets', 'app.js'),
    })
    expect(resolveStaticPath(root, '/')).toEqual({ kind: 'fallback' })
    expect(resolveStaticPath(root, '/pair')).toEqual({ kind: 'file', path: resolve(root, 'pair') })
  })

  it('rejects traversal in plain and encoded forms', () => {
    for (const url of [
      '/../secret',
      '/assets/../../secret',
      '/%2e%2e/secret',
      '/%2e%2e%2fsecret',
      '/..%2fsecret',
      '/assets/%2e%2e/%2e%2e/secret',
    ]) {
      expect(resolveStaticPath(root, url).kind, url).toBe('forbidden')
    }
  })

  it('rejects absolute, backslash and NUL paths', () => {
    expect(resolveStaticPath(root, '//etc/passwd').kind).toBe('forbidden')
    expect(resolveStaticPath(root, '/%2fetc/passwd').kind).toBe('forbidden')
    expect(resolveStaticPath(root, '/C:/Windows/win.ini').kind).toBe('forbidden')
    expect(resolveStaticPath(root, '/assets\\app.js').kind).toBe('forbidden')
    expect(resolveStaticPath(root, '/assets/%00app.js').kind).toBe('forbidden')
  })

  it('rejects malformed percent encoding', () => {
    expect(resolveStaticPath(root, '/%zz').kind).toBe('forbidden')
  })
})

describe('asset metadata', () => {
  it('maps content types and marks the shell as no-cache', () => {
    expect(contentTypeFor('/srv/mobile/index.html')).toContain('text/html')
    expect(contentTypeFor('/srv/mobile/sw.js')).toContain('javascript')
    expect(contentTypeFor('/srv/mobile/font.woff2')).toBe('font/woff2')
    expect(contentTypeFor('/srv/mobile/blob.bin')).toBe('application/octet-stream')
    expect(isNoCacheAsset('/srv/mobile/index.html')).toBe(true)
    expect(isNoCacheAsset('/srv/mobile/sw.js')).toBe(true)
    expect(isNoCacheAsset('/srv/mobile/theme-boot.js')).toBe(true)
    expect(isNoCacheAsset('/srv/mobile/app.js')).toBe(false)
  })
})
