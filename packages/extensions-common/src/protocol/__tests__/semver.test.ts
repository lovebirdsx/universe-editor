import { describe, expect, it } from 'vitest'
import { compareVersions, satisfies } from '../semver.js'

describe('satisfies', () => {
  describe('wildcard / empty range', () => {
    it('matches any version for *, x, X and empty', () => {
      for (const range of ['*', 'x', 'X', '', '   ']) {
        expect(satisfies('1.2.3', range)).toBe(true)
        expect(satisfies('0.0.1', range)).toBe(true)
      }
    })
  })

  describe('exact / partial (no operator, or =)', () => {
    it('matches a full exact version', () => {
      expect(satisfies('1.2.3', '1.2.3')).toBe(true)
      expect(satisfies('1.2.3', '=1.2.3')).toBe(true)
      expect(satisfies('1.2.4', '1.2.3')).toBe(false)
    })

    it('treats a partial spec as a prefix match', () => {
      expect(satisfies('1.2.3', '1')).toBe(true)
      expect(satisfies('1.2.3', '1.2')).toBe(true)
      expect(satisfies('2.0.0', '1')).toBe(false)
      expect(satisfies('1.3.0', '1.2')).toBe(false)
    })

    it('treats x / * inside a partial spec as wildcard components', () => {
      expect(satisfies('1.9.9', '1.x')).toBe(true)
      expect(satisfies('1.2.9', '1.2.*')).toBe(true)
      expect(satisfies('2.0.0', '1.x')).toBe(false)
    })
  })

  describe('comparison operators', () => {
    it('>= and >', () => {
      expect(satisfies('1.2.3', '>=1.2.3')).toBe(true)
      expect(satisfies('1.2.2', '>=1.2.3')).toBe(false)
      expect(satisfies('1.2.4', '>1.2.3')).toBe(true)
      expect(satisfies('1.2.3', '>1.2.3')).toBe(false)
    })

    it('<= and <', () => {
      expect(satisfies('1.2.3', '<=1.2.3')).toBe(true)
      expect(satisfies('1.2.4', '<=1.2.3')).toBe(false)
      expect(satisfies('1.2.2', '<1.2.3')).toBe(true)
      expect(satisfies('1.2.3', '<1.2.3')).toBe(false)
    })

    it('coerces partial comparator targets (>=1 → >=1.0.0)', () => {
      expect(satisfies('1.0.0', '>=1')).toBe(true)
      expect(satisfies('0.9.9', '>=1')).toBe(false)
      expect(satisfies('1.2.0', '<1.3')).toBe(true)
    })
  })

  describe('caret (^)', () => {
    it('major > 0 locks the major', () => {
      expect(satisfies('1.5.9', '^1.2.3')).toBe(true)
      expect(satisfies('2.0.0', '^1.2.3')).toBe(false)
      expect(satisfies('1.2.2', '^1.2.3')).toBe(false)
    })

    it('0.x base locks the minor (npm 0.x semantics)', () => {
      expect(satisfies('0.2.9', '^0.2.3')).toBe(true)
      expect(satisfies('0.3.0', '^0.2.3')).toBe(false)
    })

    it('0.0.x base locks the patch', () => {
      expect(satisfies('0.0.3', '^0.0.3')).toBe(true)
      expect(satisfies('0.0.4', '^0.0.3')).toBe(false)
    })
  })

  describe('tilde (~)', () => {
    it('locks the minor', () => {
      expect(satisfies('1.2.9', '~1.2.3')).toBe(true)
      expect(satisfies('1.3.0', '~1.2.3')).toBe(false)
      expect(satisfies('1.2.2', '~1.2.3')).toBe(false)
    })
  })

  describe('space-joined ANDs', () => {
    it('requires every comparator (the engines.universe form)', () => {
      expect(satisfies('0.5.0', '>=0.1.0 <1.0.0')).toBe(true)
      expect(satisfies('0.1.0', '>=0.1.0 <1.0.0')).toBe(true)
      expect(satisfies('1.0.0', '>=0.1.0 <1.0.0')).toBe(false)
      expect(satisfies('0.0.9', '>=0.1.0 <1.0.0')).toBe(false)
    })
  })

  describe('fail-closed on unparseable input', () => {
    it('rejects an unparseable version', () => {
      expect(satisfies('not-a-version', '*')).toBe(false)
      expect(satisfies('1.2', '>=1.0.0')).toBe(false)
    })

    it('rejects OR (||) ranges — unsupported', () => {
      expect(satisfies('1.2.3', '1.x || 2.x')).toBe(false)
    })

    it('rejects a comparator whose target is unparseable', () => {
      expect(satisfies('1.2.3', '>=nope')).toBe(false)
    })
  })

  it('tolerates a leading v and surrounding whitespace', () => {
    expect(satisfies('v1.2.3', '>=1.0.0')).toBe(true)
    expect(satisfies('1.2.3', '  >=1.0.0  ')).toBe(true)
  })
})

describe('compareVersions', () => {
  it('returns -1 / 0 / 1', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1)
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('orders by major then minor then patch', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
    expect(compareVersions('1.2.9', '1.2.10')).toBe(-1)
  })

  it('sorts unparseable versions as 0.0.0', () => {
    expect(compareVersions('garbage', '0.0.0')).toBe(0)
    expect(compareVersions('garbage', '0.0.1')).toBe(-1)
    expect(compareVersions('0.0.1', 'garbage')).toBe(1)
  })
})
