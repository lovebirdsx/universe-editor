/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/configuration/jsonSchemaRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { JSONContributionRegistry } from '../../configuration/jsonSchemaRegistry.js'

describe('JSONContributionRegistry', () => {
  it('registers and lists a contribution', () => {
    const d = JSONContributionRegistry.registerSchema({
      uri: 'test://schemas/a',
      fileMatch: ['a.json'],
      schema: { type: 'object' },
    })
    expect(
      JSONContributionRegistry.getContributions().some((c) => c.uri === 'test://schemas/a'),
    ).toBe(true)
    d.dispose()
    expect(
      JSONContributionRegistry.getContributions().some((c) => c.uri === 'test://schemas/a'),
    ).toBe(false)
  })

  it('replaces a contribution registered under the same URI', () => {
    const d1 = JSONContributionRegistry.registerSchema({
      uri: 'test://schemas/b',
      fileMatch: ['b.json'],
      schema: { type: 'object', properties: { x: { type: 'string' } } },
    })
    const d2 = JSONContributionRegistry.registerSchema({
      uri: 'test://schemas/b',
      fileMatch: ['b.json'],
      schema: { type: 'object', properties: { y: { type: 'number' } } },
    })
    const all = JSONContributionRegistry.getContributions().filter(
      (c) => c.uri === 'test://schemas/b',
    )
    expect(all).toHaveLength(1)
    expect(all[0]?.schema.properties).toEqual({ y: { type: 'number' } })

    // Disposing the older registration should NOT delete the replacement.
    d1.dispose()
    expect(
      JSONContributionRegistry.getContributions().some((c) => c.uri === 'test://schemas/b'),
    ).toBe(true)
    d2.dispose()
    expect(
      JSONContributionRegistry.getContributions().some((c) => c.uri === 'test://schemas/b'),
    ).toBe(false)
  })

  it('fires onDidChangeContributions on register and dispose', () => {
    const spy = vi.fn()
    const sub = JSONContributionRegistry.onDidChangeContributions(spy)
    const d = JSONContributionRegistry.registerSchema({
      uri: 'test://schemas/c',
      fileMatch: ['c.json'],
      schema: { type: 'object' },
    })
    expect(spy).toHaveBeenCalledTimes(1)
    d.dispose()
    expect(spy).toHaveBeenCalledTimes(2)
    sub.dispose()
  })
})
