/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/uuid.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { generateUuid } from '../../base/uuid.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('generateUuid', () => {
  it('produces an RFC 4122 v4 UUID', () => {
    expect(generateUuid()).toMatch(UUID_V4)
  })

  it('produces unique values', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i++) set.add(generateUuid())
    expect(set.size).toBe(1000)
  })
})
