import { describe, it, expect } from 'vitest'
import { validateExtensionName, validatePublisher } from '../validate.js'

describe('validateExtensionName', () => {
  it.each(['my-ext', 'a.b', 'a_b', 'pdf2', 'a'])('accepts %s', (name) => {
    expect(validateExtensionName(name)).toBeNull()
  })

  it.each(['', 'My-Ext', 'my ext', '.hidden', '-lead', 'trail.', 'trail-', 'a..b', 'x'.repeat(65)])(
    'rejects %j',
    (name) => {
      expect(validateExtensionName(name)).toBeTypeOf('string')
    },
  )
})

describe('validatePublisher', () => {
  it.each(['acme', 'a', 'my-team', 'team2'])('accepts %s', (id) => {
    expect(validatePublisher(id)).toBeNull()
  })

  it.each(['', 'Acme', 'my_team', '-lead', 'x'.repeat(33)])('rejects %j', (id) => {
    expect(validatePublisher(id)).toBeTypeOf('string')
  })
})
