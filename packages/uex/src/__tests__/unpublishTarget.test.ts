import { describe, it, expect } from 'vitest'
import { parseUnpublishTarget } from '../lib/unpublishTarget.js'
import { UexError } from '../errors.js'

describe('parseUnpublishTarget', () => {
  it('splits publisher.name@version', () => {
    expect(parseUnpublishTarget('acme.demo@1.0.0')).toEqual({ id: 'acme.demo', version: '1.0.0' })
  })

  it('treats a bare id as whole-extension removal', () => {
    expect(parseUnpublishTarget('acme.demo')).toEqual({ id: 'acme.demo', version: null })
  })

  it('rejects ids without a publisher prefix', () => {
    expect(() => parseUnpublishTarget('demo@1.0.0')).toThrow(UexError)
    expect(() => parseUnpublishTarget('demo')).toThrow(UexError)
  })

  it('rejects malformed targets', () => {
    expect(() => parseUnpublishTarget('@1.0.0')).toThrow(UexError)
    expect(() => parseUnpublishTarget('acme.demo@')).toThrow(UexError)
  })
})
