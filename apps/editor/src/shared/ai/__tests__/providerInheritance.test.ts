/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  providerInheritance tests — the two questions the extends UI asks: "who may I
 *  point at without forming a cycle" and "which ancestor actually supplied this
 *  value". Both walk a hand-editable graph, so every case here includes one that
 *  already loops.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiProviderEntry } from '@universe-editor/platform'
import {
  computeExtendsCandidates,
  effectiveConnection,
  effectivePricingSource,
  effectiveRemoteSource,
  effectiveUsageSource,
  findInherited,
} from '../providerInheritance.js'

describe('computeExtendsCandidates', () => {
  const chain: readonly AiProviderEntry[] = [
    { id: 'root' },
    { id: 'mid', extends: 'root' },
    { id: 'leaf', extends: 'mid' },
    { id: 'other' },
  ]

  it('excludes self and every descendant, but not ancestors', () => {
    // `mid` may re-point at its own current parent's siblings, and even at
    // `root` again — what it may not do is point down at `leaf`.
    expect(computeExtendsCandidates('mid', chain)).toEqual(['root', 'other'])
  })

  it('offers the whole chain to an entry nobody extends', () => {
    expect(computeExtendsCandidates('other', chain)).toEqual(['root', 'mid', 'leaf'])
  })

  it('terminates on a graph that already contains a cycle', () => {
    const looped: readonly AiProviderEntry[] = [
      { id: 'a', extends: 'b' },
      { id: 'b', extends: 'a' },
      { id: 'c' },
    ]
    expect(computeExtendsCandidates('c', looped)).toEqual(['a', 'b'])
  })
})

describe('findInherited', () => {
  const providers: readonly AiProviderEntry[] = [
    { id: 'root', baseUrl: 'https://root.example', defaultProtocol: 'openai-chat' },
    { id: 'mid', extends: 'root', defaultProtocol: 'ollama' },
    { id: 'leaf', extends: 'mid' },
  ]

  it('reports the nearest ancestor that declares the field', () => {
    expect(findInherited(providers[2]!, providers, 'defaultProtocol')).toEqual({
      from: 'mid',
      value: 'ollama',
    })
  })

  it('walks past ancestors that leave the field unset', () => {
    expect(findInherited(providers[2]!, providers, 'baseUrl')).toEqual({
      from: 'root',
      value: 'https://root.example',
    })
  })

  it('returns undefined when nothing up the chain declares it', () => {
    expect(findInherited(providers[2]!, providers, 'apiKey')).toBeUndefined()
  })

  it('returns undefined for a dangling extends', () => {
    expect(findInherited({ id: 'x', extends: 'nope' }, providers, 'baseUrl')).toBeUndefined()
  })

  it('terminates on a cycle instead of hanging', () => {
    const looped: readonly AiProviderEntry[] = [
      { id: 'a', extends: 'b' },
      { id: 'b', extends: 'a' },
    ]
    expect(findInherited(looped[0]!, looped, 'baseUrl')).toBeUndefined()
  })
})

describe('effectiveConnection', () => {
  const chain: readonly AiProviderEntry[] = [
    { id: 'root', baseUrl: 'https://root.example', apiKey: 'sk-root' },
    { id: 'mid', extends: 'root', baseUrl: 'https://mid.example' },
    { id: 'leaf', extends: 'mid' },
  ]

  it('takes each field from the nearest declaring ancestor, independently', () => {
    expect(effectiveConnection(chain[2]!, chain)).toEqual({
      baseUrl: 'https://mid.example',
      apiKey: 'sk-root',
    })
  })

  it('prefers the entry own values over anything inherited', () => {
    const own: AiProviderEntry = { id: 'own', extends: 'root', baseUrl: 'https://own.example' }
    expect(effectiveConnection(own, [...chain, own])).toEqual({
      baseUrl: 'https://own.example',
      apiKey: 'sk-root',
    })
  })

  // Absent, not empty: an empty string would be sent as a real (blank) credential.
  it('omits keys nothing declares rather than emitting undefined values', () => {
    const result = effectiveConnection({ id: 'lonely' }, [{ id: 'lonely' }])
    expect(result).toEqual({})
    expect('apiKey' in result).toBe(false)
  })
})

describe('effectiveRemoteSource', () => {
  const chain: readonly AiProviderEntry[] = [
    { id: 'root', usageSource: { id: 'http-json', options: { path: '/root/usage' } } },
    { id: 'mid', extends: 'root', pricingSource: { id: 'catalog', options: { vendor: 'openai' } } },
    { id: 'leaf', extends: 'mid' },
  ]

  it('marks an entry own source as not inherited, attributed to itself', () => {
    expect(effectiveRemoteSource(chain[1]!, chain, 'pricingSource')).toEqual({
      value: { id: 'catalog', options: { vendor: 'openai' } },
      from: 'mid',
      inherited: false,
    })
  })

  it('resolves a purely inheriting entry to the nearest declaring ancestor', () => {
    // The bug this function exists for: `leaf` declares no usageSource, yet main
    // has already fetched usage under the id `leaf`.
    expect(effectiveRemoteSource(chain[2]!, chain, 'usageSource')).toEqual({
      value: { id: 'http-json', options: { path: '/root/usage' } },
      from: 'root',
      inherited: true,
    })
  })

  it('walks past an ancestor that declares only the other source field', () => {
    expect(effectiveRemoteSource(chain[2]!, chain, 'pricingSource')).toEqual({
      value: { id: 'catalog', options: { vendor: 'openai' } },
      from: 'mid',
      inherited: true,
    })
  })

  it('prefers an own declaration over an inherited one', () => {
    const own: AiProviderEntry = {
      id: 'own',
      extends: 'root',
      usageSource: { id: 'http-json', options: { path: '/own/usage' } },
    }
    expect(effectiveRemoteSource(own, [...chain, own], 'usageSource')).toEqual({
      value: { id: 'http-json', options: { path: '/own/usage' } },
      from: 'own',
      inherited: false,
    })
  })

  it('returns undefined when nothing in the chain declares the field', () => {
    expect(effectiveRemoteSource(chain[1]!, chain, 'usageSource')).toBeDefined()
    expect(
      effectiveRemoteSource({ id: 'lonely' }, [{ id: 'lonely' }], 'usageSource'),
    ).toBeUndefined()
  })

  it('terminates on a cycle instead of hanging', () => {
    const looped: readonly AiProviderEntry[] = [
      { id: 'a', extends: 'b' },
      { id: 'b', extends: 'a' },
    ]
    expect(effectiveRemoteSource(looped[0]!, looped, 'usageSource')).toBeUndefined()
  })

  it('exposes field-bound wrappers that agree with the generic form', () => {
    expect(effectiveUsageSource(chain[2]!, chain)).toEqual(
      effectiveRemoteSource(chain[2]!, chain, 'usageSource'),
    )
    expect(effectivePricingSource(chain[2]!, chain)).toEqual(
      effectiveRemoteSource(chain[2]!, chain, 'pricingSource'),
    )
  })
})
