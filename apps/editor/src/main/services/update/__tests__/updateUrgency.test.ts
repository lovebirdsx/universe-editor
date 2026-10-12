/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/update/updateUrgency.ts
 *  Focus: the urgency lookup is best-effort — every failure resolves to `undefined`
 *  (never a throw) so a missing marker can only ever degrade to "normal update".
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  feedUrlFromUpdateConfig,
  fetchUrgencyFromSiteIndex,
  siteIndexUrl,
  updaterConfigPath,
  urgencyForVersion,
} from '../updateUrgency.js'

describe('updaterConfigPath', () => {
  it('follows electron-updater dev / packaged convention', () => {
    // Expected values go through join(): the contract is which directory each mode
    // reads from, not the separator the running platform happens to use.
    expect(
      updaterConfigPath({
        isPackaged: false,
        resourcesPath: '/res',
        appPath: '/app',
      }),
    ).toBe(join('/app', 'dev-app-update.yml'))
    expect(updaterConfigPath({ isPackaged: true, resourcesPath: '/res', appPath: '/app' })).toBe(
      join('/res', 'app-update.yml'),
    )
  })
})

describe('feedUrlFromUpdateConfig', () => {
  it('reads the url line from a generated feed config', () => {
    const text = ['provider: generic', 'url: http://localhost:8788/', 'channel: latest'].join('\n')
    expect(feedUrlFromUpdateConfig(text)).toBe('http://localhost:8788/')
  })

  it('unwraps quoted values and tolerates trailing whitespace', () => {
    expect(feedUrlFromUpdateConfig('url: "http://host.example.com/feed/"')).toBe(
      'http://host.example.com/feed/',
    )
    expect(feedUrlFromUpdateConfig("url: 'http://host.example.com/feed/'")).toBe(
      'http://host.example.com/feed/',
    )
    expect(feedUrlFromUpdateConfig('url: http://host.example.com/feed/  ')).toBe(
      'http://host.example.com/feed/',
    )
  })

  it('returns undefined when there is no usable url', () => {
    expect(feedUrlFromUpdateConfig('provider: generic\nchannel: latest')).toBeUndefined()
    expect(feedUrlFromUpdateConfig('url:')).toBeUndefined()
    expect(feedUrlFromUpdateConfig('url:   ')).toBeUndefined()
    expect(feedUrlFromUpdateConfig('')).toBeUndefined()
  })
})

describe('siteIndexUrl', () => {
  it('appends the notes path under the feed directory', () => {
    expect(siteIndexUrl('http://host.example.com/universe-editor/')).toBe(
      'http://host.example.com/universe-editor/notes/index.json',
    )
  })

  it('adds a missing trailing slash instead of replacing the last segment', () => {
    expect(siteIndexUrl('http://host.example.com/universe-editor')).toBe(
      'http://host.example.com/universe-editor/notes/index.json',
    )
  })

  it('keeps the feed query string so a token-protected feed still answers', () => {
    expect(siteIndexUrl('http://host.example.com/feed/?token=ak-1')).toBe(
      'http://host.example.com/feed/notes/index.json?token=ak-1',
    )
  })

  it('refuses anything that is not http(s)', () => {
    expect(siteIndexUrl('file:///srv/universe-editor/')).toBeUndefined()
    expect(siteIndexUrl('not a url')).toBeUndefined()
    expect(siteIndexUrl('')).toBeUndefined()
  })
})

describe('urgencyForVersion', () => {
  const index = {
    schema: 1,
    versions: [
      { version: '0.15.2', urgency: 'important' },
      { version: '0.15.1', urgency: 'normal' },
      { version: '0.15.0' },
    ],
  }

  it('reads the flag for the version being offered', () => {
    expect(urgencyForVersion(index, '0.15.2')).toBe('important')
    expect(urgencyForVersion(index, '0.15.1')).toBe('normal')
    expect(urgencyForVersion(index, '0.15.0')).toBe('normal')
  })

  it('treats a version missing from a readable index as normal', () => {
    // Retrying cannot change this, so the caller is free to cache it.
    expect(urgencyForVersion(index, '9.9.9')).toBe('normal')
  })

  it('returns undefined for a shape it cannot read', () => {
    expect(urgencyForVersion(undefined, '0.15.2')).toBeUndefined()
    expect(urgencyForVersion(null, '0.15.2')).toBeUndefined()
    expect(urgencyForVersion('nope', '0.15.2')).toBeUndefined()
    expect(urgencyForVersion({}, '0.15.2')).toBeUndefined()
    expect(urgencyForVersion({ versions: 'nope' }, '0.15.2')).toBeUndefined()
  })

  it('skips junk entries without failing the lookup', () => {
    const withJunk = { versions: [null, 'x', { version: '0.15.2', urgency: 'important' }] }
    expect(urgencyForVersion(withJunk, '0.15.2')).toBe('important')
  })

  it('only the exact string "important" is treated as important', () => {
    expect(
      urgencyForVersion({ versions: [{ version: '1.0.0', urgency: 'IMPORTANT' }] }, '1.0.0'),
    ).toBe('normal')
    expect(urgencyForVersion({ versions: [{ version: '1.0.0', urgency: true }] }, '1.0.0')).toBe(
      'normal',
    )
  })
})

describe('fetchUrgencyFromSiteIndex', () => {
  const params = { url: 'http://host.example.com/feed/notes/index.json', version: '0.15.2' }

  it('returns the flag on a good response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ versions: [{ version: '0.15.2', urgency: 'important' }] }), {
          status: 200,
        }),
    )
    expect(await fetchUrgencyFromSiteIndex({ ...params, fetchImpl })).toBe('important')
  })

  it('returns undefined on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
    expect(await fetchUrgencyFromSiteIndex({ ...params, fetchImpl })).toBeUndefined()
  })

  it('returns undefined on malformed JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 200 }))
    expect(await fetchUrgencyFromSiteIndex({ ...params, fetchImpl })).toBeUndefined()
  })

  it('returns undefined when the network fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await fetchUrgencyFromSiteIndex({ ...params, fetchImpl })).toBeUndefined()
  })

  it('aborts and returns undefined once the timeout elapses', async () => {
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    expect(await fetchUrgencyFromSiteIndex({ ...params, timeoutMs: 10, fetchImpl })).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
