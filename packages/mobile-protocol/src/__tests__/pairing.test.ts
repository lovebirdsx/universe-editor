import { describe, expect, it } from 'vitest'
import {
  MOBILE_PAIR_PAGE_PATH,
  MOBILE_PAIR_PATH,
  MOBILE_WS_PATH,
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  buildPairUrl,
  formatCertFingerprint,
  formatPairCode,
  generatePairCode,
  isValidPairCodeShape,
  normalizeCertFingerprint,
  normalizePairCode,
  parsePairFragment,
  parsePairFingerprint,
} from '../index.js'

describe('pairing paths', () => {
  it('exposes the HTTP and WebSocket endpoints', () => {
    expect(MOBILE_PAIR_PATH).toBe('/api/pair')
    expect(MOBILE_WS_PATH).toBe('/ws')
    expect(MOBILE_PAIR_PAGE_PATH).toBe('/pair')
  })
})

describe('PAIR_CODE_ALPHABET', () => {
  it('has 32 unique symbols without ambiguous characters', () => {
    expect(PAIR_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(PAIR_CODE_ALPHABET).size).toBe(32)
    for (const ambiguous of '0ILO') {
      expect(PAIR_CODE_ALPHABET).not.toContain(ambiguous)
    }
  })
})

describe('generatePairCode', () => {
  it('maps injected bytes to alphabet indices', () => {
    const code = generatePairCode((values) => {
      values.set([0, 1, 2, 3, 4, 5, 6, 7])
      return values
    })
    expect(code).toBe('12345678')
    expect(code).toHaveLength(PAIR_CODE_LENGTH)
  })

  it('requests exactly PAIR_CODE_LENGTH random bytes', () => {
    let requestedLength = -1
    generatePairCode((values) => {
      requestedLength = values.length
      values.fill(0)
      return values
    })
    expect(requestedLength).toBe(PAIR_CODE_LENGTH)
  })

  it('samples every byte uniformly across the 32-symbol alphabet', () => {
    for (let value = 0; value < 256; value += 1) {
      const code = generatePairCode((values) => {
        values.fill(value)
        return values
      })
      expect(code).toBe(PAIR_CODE_ALPHABET.charAt(value & 31).repeat(PAIR_CODE_LENGTH))
      for (const char of code) expect(PAIR_CODE_ALPHABET).toContain(char)
    }
  })
})

describe('normalizePairCode', () => {
  it('strips whitespace and hyphens and uppercases', () => {
    expect(normalizePairCode(' abcd-2345 ')).toBe('ABCD2345')
    expect(normalizePairCode('AB CD 23 45')).toBe('ABCD2345')
    expect(normalizePairCode('abcd2345')).toBe('ABCD2345')
  })
})

describe('formatPairCode', () => {
  it('displays eight symbols as XXXX-XXXX', () => {
    expect(formatPairCode('abcd2345')).toBe('ABCD-2345')
    expect(formatPairCode('ABCD-2345')).toBe('ABCD-2345')
  })

  it('returns the normalized value unchanged when malformed', () => {
    expect(formatPairCode('abc')).toBe('ABC')
  })
})

describe('isValidPairCodeShape', () => {
  it('accepts normalized and display forms', () => {
    expect(isValidPairCodeShape('abcd-2345')).toBe(true)
    expect(isValidPairCodeShape('ABCD2345')).toBe(true)
  })

  it('rejects wrong lengths and symbols outside the alphabet', () => {
    expect(isValidPairCodeShape('ABCD234')).toBe(false)
    expect(isValidPairCodeShape('ABCD23456')).toBe(false)
    expect(isValidPairCodeShape('ABCD23O5')).toBe(false)
    expect(isValidPairCodeShape('ABCD23I5')).toBe(false)
    expect(isValidPairCodeShape('')).toBe(false)
  })
})

describe('pair URL round trip', () => {
  it('puts the code in the fragment and parses it back', () => {
    const url = buildPairUrl('https://192.0.2.10:8443', 'abcd-2345')
    expect(url).toBe('https://192.0.2.10:8443/pair#code=ABCD2345')
    expect(parsePairFragment(new URL(url).hash)).toBe('ABCD2345')
  })

  it('tolerates a trailing slash on the origin', () => {
    expect(buildPairUrl('https://pc.example.com/', 'ABCD2345')).toBe(
      'https://pc.example.com/pair#code=ABCD2345',
    )
  })

  it('parses fragments with and without the leading hash', () => {
    expect(parsePairFragment('#code=ABCD2345')).toBe('ABCD2345')
    expect(parsePairFragment('code=ABCD2345')).toBe('ABCD2345')
    expect(parsePairFragment('#code=abcd-2345')).toBe('ABCD2345')
  })

  it('returns undefined when the code is absent or empty', () => {
    expect(parsePairFragment('')).toBeUndefined()
    expect(parsePairFragment('#')).toBeUndefined()
    expect(parsePairFragment('#foo=bar')).toBeUndefined()
    expect(parsePairFragment('#code=')).toBeUndefined()
  })
})

describe('certificate fingerprint in pairing links', () => {
  const fingerprint = '00112233445566778899aabbccddeeff'.repeat(2)

  it('appends the fingerprint next to the code and parses it back', () => {
    const url = buildPairUrl('https://192.0.2.10:8443', 'ABCD2345', fingerprint)
    expect(url).toBe(`https://192.0.2.10:8443/pair#code=ABCD2345&fp=${fingerprint}`)
    expect(parsePairFragment(new URL(url).hash)).toBe('ABCD2345')
    expect(parsePairFingerprint(new URL(url).hash)).toBe(fingerprint)
  })

  it('accepts browser-style uppercase colon-separated fingerprints', () => {
    const display = formatCertFingerprint(fingerprint)
    expect(display).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u)
    expect(normalizeCertFingerprint(display)).toBe(fingerprint)
    const url = buildPairUrl('https://192.0.2.10:8443', 'ABCD2345', display)
    expect(url.endsWith(`&fp=${fingerprint}`)).toBe(true)
  })

  it('omits the fingerprint when absent or malformed', () => {
    expect(buildPairUrl('https://pc.example.com', 'ABCD2345')).toBe(
      'https://pc.example.com/pair#code=ABCD2345',
    )
    expect(buildPairUrl('https://pc.example.com', 'ABCD2345', 'not-a-fingerprint')).toBe(
      'https://pc.example.com/pair#code=ABCD2345',
    )
    expect(parsePairFingerprint('#code=ABCD2345&fp=bogus')).toBeUndefined()
    expect(parsePairFingerprint('#code=ABCD2345')).toBeUndefined()
  })
})
