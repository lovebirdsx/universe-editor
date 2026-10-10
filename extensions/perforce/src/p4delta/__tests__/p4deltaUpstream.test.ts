import { describe, expect, it } from 'vitest'
import {
  assetNameFor,
  assetUrl,
  latestUrl,
  latestVersionFrom,
  P4DELTA_DEFAULT_SOURCE,
  p4deltaTargetTriple,
  parseSha256Sums,
  releaseBaseUrl,
  resolveP4deltaSource,
  sourceFromBaseUrl,
  type P4deltaSource,
} from '../p4deltaUpstream.js'

const GITHUB = P4DELTA_DEFAULT_SOURCE
const MIRROR: P4deltaSource = { mode: 'mirror', baseUrl: 'https://updates.example.com/p4delta' }

describe('p4deltaTargetTriple', () => {
  it('maps the one platform upstream publishes', () => {
    expect(p4deltaTargetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc')
  })

  it('reports no asset for everything else', () => {
    expect(p4deltaTargetTriple('win32', 'arm64')).toBeUndefined()
    expect(p4deltaTargetTriple('darwin', 'arm64')).toBeUndefined()
    expect(p4deltaTargetTriple('linux', 'x64')).toBeUndefined()
  })
})

describe('assetNameFor', () => {
  it('is the name a mirror must publish and the URL is built from', () => {
    expect(assetNameFor('0.1.10', 'x86_64-pc-windows-msvc')).toBe(
      'p4delta-0.1.10-x86_64-pc-windows-msvc.zip',
    )
  })
})

describe('sourceFromBaseUrl', () => {
  it('normalizes trailing slashes away', () => {
    expect(sourceFromBaseUrl('https://updates.example.com/p4delta/')).toEqual({
      mode: 'mirror',
      baseUrl: 'https://updates.example.com/p4delta',
    })
    expect(sourceFromBaseUrl('https://updates.example.com/p4delta///')).toEqual({
      mode: 'mirror',
      baseUrl: 'https://updates.example.com/p4delta',
    })
  })

  it('refuses anything that is not an absolute http(s) URL', () => {
    expect(sourceFromBaseUrl('')).toBeUndefined()
    expect(sourceFromBaseUrl('   ')).toBeUndefined()
    expect(sourceFromBaseUrl('/srv/p4delta')).toBeUndefined()
    expect(sourceFromBaseUrl('updates.example.com/p4delta')).toBeUndefined()
    expect(sourceFromBaseUrl('ftp://updates.example.com/p4delta')).toBeUndefined()
  })
})

describe('resolveP4deltaSource', () => {
  const logs: string[] = []
  const log = (msg: string) => logs.push(msg)

  it('falls back to GitHub when neither override names anything', () => {
    logs.length = 0
    expect(resolveP4deltaSource(undefined, '', log)).toEqual(GITHUB)
    expect(resolveP4deltaSource('', '  ', log)).toEqual(GITHUB)
    expect(logs).toEqual([])
  })

  it('prefers the environment override over the setting', () => {
    logs.length = 0
    expect(
      resolveP4deltaSource('https://env.example.com/p4', 'https://set.example.com/p4', log),
    ).toEqual({ mode: 'mirror', baseUrl: 'https://env.example.com/p4' })
    // An empty override is not an override: the setting is still the answer.
    expect(resolveP4deltaSource('', 'https://set.example.com/p4', log)).toEqual({
      mode: 'mirror',
      baseUrl: 'https://set.example.com/p4',
    })
  })

  // The escape hatch must not be able to break a machine that would have worked
  // out of the box, so a typo degrades to the default instead of failing.
  it('demotes a value that is not an absolute URL, and says so', () => {
    logs.length = 0
    expect(resolveP4deltaSource(undefined, '/srv/p4delta', log)).toEqual(GITHUB)
    expect(logs.some((msg) => msg.includes('/srv/p4delta'))).toBe(true)
  })

  it('allows a plain-http mirror but warns about the channel', () => {
    logs.length = 0
    expect(resolveP4deltaSource(undefined, 'http://192.0.2.10/p4', log)).toEqual({
      mode: 'mirror',
      baseUrl: 'http://192.0.2.10/p4',
    })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('http://192.0.2.10/p4')

    logs.length = 0
    resolveP4deltaSource(undefined, 'https://updates.example.com/p4', log)
    expect(logs).toEqual([])
  })
})

describe('URL construction', () => {
  it('addresses the latest-release document per source', () => {
    expect(latestUrl(GITHUB)).toBe(
      'https://api.github.com/repos/lovebirdsx/p4delta/releases/latest',
    )
    expect(latestUrl(MIRROR)).toBe('https://updates.example.com/p4delta/latest.json')
  })

  it('addresses the release directory per source', () => {
    expect(releaseBaseUrl(GITHUB, '0.1.10')).toBe(
      'https://github.com/lovebirdsx/p4delta/releases/download/v0.1.10',
    )
    expect(releaseBaseUrl(MIRROR, '0.1.10')).toBe('https://updates.example.com/p4delta')
  })

  it('joins assets onto a release directory', () => {
    expect(assetUrl(releaseBaseUrl(GITHUB, '0.1.10'), 'SHA256SUMS')).toBe(
      'https://github.com/lovebirdsx/p4delta/releases/download/v0.1.10/SHA256SUMS',
    )
    expect(assetUrl(releaseBaseUrl(MIRROR, '0.1.10'), 'SHA256SUMS')).toBe(
      'https://updates.example.com/p4delta/SHA256SUMS',
    )
  })
})

describe('latestVersionFrom', () => {
  it("reads GitHub's tag and a mirror's field through the same parser", () => {
    expect(latestVersionFrom(GITHUB, { tag_name: 'v0.1.10' })).toEqual([0, 1, 10])
    expect(latestVersionFrom(MIRROR, { version: '0.1.10' })).toEqual([0, 1, 10])
  })

  it('refuses a document that does not name a version', () => {
    expect(latestVersionFrom(GITHUB, { tag_name: 'nightly' })).toBeUndefined()
    expect(latestVersionFrom(GITHUB, {})).toBeUndefined()
    expect(latestVersionFrom(GITHUB, null)).toBeUndefined()
    expect(latestVersionFrom(GITHUB, 'v0.1.10')).toBeUndefined()
    expect(latestVersionFrom(MIRROR, { version: '' })).toBeUndefined()
    expect(latestVersionFrom(MIRROR, { tag_name: 'v0.1.10' })).toBeUndefined()
  })
})

describe('parseSha256Sums', () => {
  const digest = 'a'.repeat(64)
  const other = 'b'.repeat(64)
  const asset = 'p4delta-0.1.10-x86_64-pc-windows-msvc.zip'

  it('finds the line for the asset', () => {
    const text = `${other}  p4delta-0.1.9-x86_64-pc-windows-msvc.zip\n${digest}  ${asset}\n`
    expect(parseSha256Sums(text, asset)).toBe(digest)
  })

  it('handles CRLF, binary-mode markers, path prefixes and upper case', () => {
    expect(parseSha256Sums(`${digest.toUpperCase()} *${asset}\r\n`, asset)).toBe(digest)
    expect(parseSha256Sums(`${digest}  ./${asset}\n`, asset)).toBe(digest)
  })

  it('ignores comments and blank lines', () => {
    const text = `# generated by release.yml\n\n${digest}  ${asset}\n`
    expect(parseSha256Sums(text, asset)).toBe(digest)
  })

  it('reports nothing when the asset is not listed', () => {
    expect(parseSha256Sums(`${digest}  some-other-file.zip\n`, asset)).toBeUndefined()
    expect(parseSha256Sums('', asset)).toBeUndefined()
  })

  it('does not treat a malformed digest as a checked one', () => {
    expect(parseSha256Sums(`deadbeef  ${asset}\n`, asset)).toBeUndefined()
    expect(parseSha256Sums(`zzzz${'a'.repeat(60)}  ${asset}\n`, asset)).toBeUndefined()
  })
})
