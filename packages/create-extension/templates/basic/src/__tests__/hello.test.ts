import { describe, expect, it } from 'vitest'
import { getHelloMessage } from '../hello.js'

describe('getHelloMessage', () => {
  it('greets with the extension display name', () => {
    expect(getHelloMessage()).toBe('Hello from __displayName__!')
  })
})
