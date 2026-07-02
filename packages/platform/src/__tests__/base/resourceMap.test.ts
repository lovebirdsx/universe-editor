/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/resourceMap.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI, getResourceComparisonKey } from '../../base/uri.js'
import { ResourceMap, ResourceSet } from '../../base/resourceMap.js'
import type { HostPlatform } from '../../host/hostService.js'

const keyFor = (platform: HostPlatform) => (uri: URI) => getResourceComparisonKey(uri, platform)

describe('ResourceMap', () => {
  it('de-dups URIs that address the same resource (win32 case-folding)', () => {
    const map = new ResourceMap<number>(keyFor('win32'))
    map.set(URI.file('D:/x/Foo.ts'), 1)
    map.set(URI.file('d:/X/foo.ts'), 2)
    expect(map.size).toBe(1)
    expect(map.get(URI.file('D:\\x\\FOO.TS'))).toBe(2)
  })

  it('keeps case-distinct resources apart on linux', () => {
    const map = new ResourceMap<number>(keyFor('linux'))
    map.set(URI.file('/x/Foo.ts'), 1)
    map.set(URI.file('/x/foo.ts'), 2)
    expect(map.size).toBe(2)
  })

  it('has / delete use the same key identity', () => {
    const map = new ResourceMap<string>(keyFor('win32'))
    map.set(URI.file('D:/a/b.ts'), 'v')
    expect(map.has(URI.file('d:/a/b.ts'))).toBe(true)
    expect(map.delete(URI.file('D:\\a\\B.TS'))).toBe(true)
    expect(map.size).toBe(0)
  })

  it('iterates the last-written URI for each key', () => {
    const map = new ResourceMap<number>(keyFor('win32'))
    map.set(URI.file('D:/x/Foo.ts'), 1)
    map.set(URI.file('d:/x/foo.ts'), 2)
    expect([...map.values()]).toEqual([2])
    expect([...map.keys()].map((u) => u.fsPath)).toEqual(['d:/x/foo.ts'])
  })
})

describe('ResourceSet', () => {
  it('de-dups by comparison key', () => {
    const set = new ResourceSet(keyFor('win32'))
    set.add(URI.file('D:/x/Foo.ts'))
    set.add(URI.file('d:/x/foo.ts'))
    expect(set.size).toBe(1)
    expect(set.has(URI.file('D:\\X\\FOO.ts'))).toBe(true)
  })
})
