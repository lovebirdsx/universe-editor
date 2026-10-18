import { describe, expect, it } from 'vitest'
import {
  compareP4deltaVersion,
  formatP4deltaVersion,
  parseP4deltaVersion,
  parseP4deltaVersionBannerStrict,
  P4DELTA_MIN_VERSION,
} from '../p4deltaVersion.js'

describe('parseP4deltaVersion', () => {
  it('accepts the two spellings upstream uses', () => {
    expect(parseP4deltaVersion('0.1.10')).toEqual([0, 1, 10])
    expect(parseP4deltaVersion('v0.1.10')).toEqual([0, 1, 10])
    expect(parseP4deltaVersion('v0.1.6')).toEqual([0, 1, 6])
  })

  it('tolerates surrounding whitespace from a file read', () => {
    expect(parseP4deltaVersion('  v0.2.0\n')).toEqual([0, 2, 0])
  })

  it('refuses anything that is not exactly a three-part version', () => {
    expect(parseP4deltaVersion('')).toBeUndefined()
    expect(parseP4deltaVersion('0.1')).toBeUndefined()
    expect(parseP4deltaVersion('0.1.10.1')).toBeUndefined()
    expect(parseP4deltaVersion('p4delta 0.1.6')).toBeUndefined()
    expect(parseP4deltaVersion('v0.1.10-rc1')).toBeUndefined()
    expect(parseP4deltaVersion('0.1.x')).toBeUndefined()
    expect(parseP4deltaVersion('latest')).toBeUndefined()
  })
})

describe('parseP4deltaVersionBannerStrict', () => {
  it('reads the clap banner', () => {
    expect(parseP4deltaVersionBannerStrict('p4delta 0.1.19\n')).toEqual([0, 1, 19])
    expect(parseP4deltaVersionBannerStrict('p4delta\tv0.1.6\n')).toEqual([0, 1, 6])
  })

  it('finds the banner on a later line', () => {
    expect(parseP4deltaVersionBannerStrict('note\np4delta 0.1.19\n')).toEqual([0, 1, 19])
  })

  it('refuses output that is not a p4delta banner', () => {
    expect(parseP4deltaVersionBannerStrict('mytool 9.9.9\n')).toBeUndefined()
    expect(parseP4deltaVersionBannerStrict('p4delta\n0.1.19\n')).toBeUndefined()
    expect(parseP4deltaVersionBannerStrict('p4delta 0.1\n')).toBeUndefined()
    expect(parseP4deltaVersionBannerStrict('p4delta 0.1.19junk\n')).toBeUndefined()
    expect(parseP4deltaVersionBannerStrict('p4delta 0.1.19.5\n')).toBeUndefined()
    expect(parseP4deltaVersionBannerStrict('')).toBeUndefined()
  })

  it('treats a pre-release or build suffix as the version it names', () => {
    expect(parseP4deltaVersionBannerStrict('p4delta 0.1.19-rc1\n')).toEqual([0, 1, 19])
    expect(parseP4deltaVersionBannerStrict('p4delta 0.1.19+build.1\r\n')).toEqual([0, 1, 19])
  })
})

describe('P4DELTA_MIN_VERSION', () => {
  it('is the product decision this build drives', () => {
    expect(P4DELTA_MIN_VERSION).toEqual([0, 1, 19])
  })
})

describe('formatP4deltaVersion', () => {
  it('is the spelling every on-disk name uses', () => {
    expect(formatP4deltaVersion([0, 1, 10])).toBe('0.1.10')
    expect(formatP4deltaVersion([1, 0, 0])).toBe('1.0.0')
  })
})

describe('compareP4deltaVersion', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareP4deltaVersion([0, 1, 10], [0, 1, 6])).toBeGreaterThan(0)
    expect(compareP4deltaVersion([0, 1, 6], [0, 1, 10])).toBeLessThan(0)
    expect(compareP4deltaVersion([0, 2, 0], [0, 10, 0])).toBeLessThan(0)
    expect(compareP4deltaVersion([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0)
  })

  it('reports equality for the same version spelled differently', () => {
    const a = parseP4deltaVersion('v0.1.10')
    const b = parseP4deltaVersion('0.1.10')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(compareP4deltaVersion(a!, b!)).toBe(0)
  })
})
