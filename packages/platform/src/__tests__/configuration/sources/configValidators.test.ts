import { describe, expect, it } from 'vitest'
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  isHttpUrl,
} from '../../../configuration/sources/configValidators.js'

describe('asString', () => {
  it('passes through non-empty strings and rejects the rest', () => {
    expect(asString('x')).toBe('x')
    expect(asString('')).toBeUndefined()
    expect(asString(true)).toBeUndefined()
    expect(asString(undefined)).toBeUndefined()
  })
})

describe('asBoolean', () => {
  it('treats only 1/true as true', () => {
    expect(asBoolean('1')).toBe(true)
    expect(asBoolean('true')).toBe(true)
    expect(asBoolean('0')).toBe(false)
    expect(asBoolean('')).toBe(false)
    expect(asBoolean('anything')).toBe(false)
    expect(asBoolean(true)).toBe(true)
    expect(asBoolean(undefined)).toBeUndefined()
  })
})

describe('asStringArray', () => {
  it('wraps a single string and passes arrays through', () => {
    expect(asStringArray('a')).toEqual(['a'])
    expect(asStringArray(['a', 'b'])).toEqual(['a', 'b'])
    expect(asStringArray('')).toBeUndefined()
    expect(asStringArray(undefined)).toBeUndefined()
  })
})

describe('asNumber', () => {
  it('passes finite numbers through', () => {
    expect(asNumber(9229)).toBe(9229)
    expect(asNumber(0)).toBe(0)
    expect(asNumber(Number.NaN)).toBeUndefined()
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('parses numeric strings', () => {
    expect(asNumber('9229')).toBe(9229)
    expect(asNumber(' 42 ')).toBe(42)
  })

  it('rejects non-numeric strings and other types', () => {
    expect(asNumber('')).toBeUndefined()
    expect(asNumber('   ')).toBeUndefined()
    expect(asNumber('abc')).toBeUndefined()
    expect(asNumber('1.5.6')).toBeUndefined()
    expect(asNumber(true)).toBeUndefined()
    expect(asNumber(['1'])).toBeUndefined()
    expect(asNumber(undefined)).toBeUndefined()
  })
})

describe('isHttpUrl', () => {
  it('accepts http/https only', () => {
    expect(isHttpUrl('http://x/')).toBe(true)
    expect(isHttpUrl('https://x/')).toBe(true)
    expect(isHttpUrl('ftp://x/')).toBe(false)
    expect(isHttpUrl('file:///x')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })
})
