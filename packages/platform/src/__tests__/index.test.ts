import { describe, expect, it } from 'vitest'
import { hello } from '../index.js'

describe('platform', () => {
  it('hello() returns platform identifier', () => {
    expect(hello()).toBe('platform')
  })
})
