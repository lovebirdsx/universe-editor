import { describe, expect, it } from 'vitest'
import { sanitizeManualPayload, sanitizeManualSourceKey } from '../triggerManualPayload.js'

describe('sanitizeManualPayload', () => {
  it('returns an empty object for non-object input', () => {
    for (const input of [undefined, null, 'text', 42, true, [], ['a']]) {
      expect(sanitizeManualPayload(input)).toEqual({})
    }
  })

  it('keeps scalar values and drops everything else', () => {
    const result = sanitizeManualPayload({
      text: 'hello',
      flag: false,
      count: 3,
      zero: 0,
      nested: { a: 1 },
      list: [1, 2],
      nothing: null,
      missing: undefined,
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      negativeInfinite: Number.NEGATIVE_INFINITY,
    })
    expect(result).toEqual({ text: 'hello', flag: false, count: 3, zero: 0 })
  })

  it('drops field names the template cannot address', () => {
    const result = sanitizeManualPayload({
      'has space': 'x',
      'has-dash': 'x',
      'has.dot': 'x',
      '': 'x',
      ['k'.repeat(65)]: 'x',
      字段: 'x',
      ok_1: 'x',
    })
    expect(result).toEqual({ ok_1: 'x' })
  })

  it('truncates strings to the poll payload limit', () => {
    const result = sanitizeManualPayload({ body: 'x'.repeat(5000) })
    expect(String(result['body'])).toHaveLength(4000)
  })

  it('keeps at most 64 fields', () => {
    const input: Record<string, string> = {}
    for (let index = 0; index < 70; index += 1) input[`f${index}`] = String(index)
    const result = sanitizeManualPayload(input)
    expect(Object.keys(result)).toHaveLength(64)
    expect(result['f63']).toBe('63')
    expect(result['f64']).toBeUndefined()
  })

  it('does not let a __proto__ field mutate the prototype', () => {
    const input = JSON.parse('{"__proto__":"x","safe":"y"}') as Record<string, unknown>
    const result = sanitizeManualPayload(input)
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(JSON.stringify(result)).toBe('{"__proto__":"x","safe":"y"}')
  })
})

describe('sanitizeManualSourceKey', () => {
  it('accepts poll keys, including spaces and unicode', () => {
    expect(sanitizeManualSourceKey('poll:item-1')).toBe('poll:item-1')
    expect(sanitizeManualSourceKey('poll:item with spaces')).toBe('poll:item with spaces')
    expect(sanitizeManualSourceKey('poll:事件-1')).toBe('poll:事件-1')
    expect(sanitizeManualSourceKey(`poll:${'x'.repeat(512)}`)).toHaveLength(517)
  })

  it('rejects malformed or unsafe keys', () => {
    expect(sanitizeManualSourceKey('item-1')).toBeUndefined()
    expect(sanitizeManualSourceKey('manual:item-1')).toBeUndefined()
    expect(sanitizeManualSourceKey('poll:')).toBeUndefined()
    expect(sanitizeManualSourceKey('poll:a\nb')).toBeUndefined()
    expect(sanitizeManualSourceKey('poll:a\rb')).toBeUndefined()
    expect(sanitizeManualSourceKey('poll:a\u0000b')).toBeUndefined()
    expect(sanitizeManualSourceKey(`poll:${'x'.repeat(513)}`)).toBeUndefined()
    expect(sanitizeManualSourceKey(42)).toBeUndefined()
    expect(sanitizeManualSourceKey(undefined)).toBeUndefined()
  })
})
