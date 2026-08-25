/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  modelKnowledgeUsage tests — who references a knowledge key and what a rename
 *  may rewrite: explicit `ref` fields are safe, string shorthands and bare ids
 *  are wire names and must stay.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiProviderEntry } from '@universe-editor/platform'

import { referencingProviders, rewriteRefsForRename } from '../modelKnowledgeUsage.js'

describe('modelKnowledgeUsage — rewriting refs for a rename', () => {
  it('rewrites only explicit ref fields, never touching the id', () => {
    const providers: readonly AiProviderEntry[] = [
      {
        id: 'gw-a',
        protocolMap: {
          'openai-chat': [
            'other-model',
            { id: 'wire-x', ref: 'kimi-k3', capabilities: { streaming: true, vision: false } },
          ],
          ollama: [{ id: 'wire-y', ref: 'kimi-k3' }],
        },
      },
    ]
    const result = rewriteRefsForRename(providers, 'kimi-k3', 'kimi-k3-copy')
    expect(result.explicitRefCount).toBe(2)
    expect(result.bareRefCount).toBe(0)
    expect(result.providers).toEqual([
      {
        id: 'gw-a',
        protocolMap: {
          'openai-chat': [
            'other-model',
            { id: 'wire-x', ref: 'kimi-k3-copy', capabilities: { streaming: true, vision: false } },
          ],
          ollama: [{ id: 'wire-y', ref: 'kimi-k3-copy' }],
        },
      },
    ])
  })

  it('leaves string shorthands and bare object ids alone, counting them as bare', () => {
    const providers: readonly AiProviderEntry[] = [
      { id: 'gw-b', protocolMap: { ollama: ['kimi-k3', { id: 'kimi-k3' }, 'unrelated'] } },
    ]
    const result = rewriteRefsForRename(providers, 'kimi-k3', 'kimi-k3-copy')
    expect(result.explicitRefCount).toBe(0)
    expect(result.bareRefCount).toBe(2)
    expect(result.providers).toBe(providers)
  })

  it('returns the original array reference when nothing changes', () => {
    const providers: readonly AiProviderEntry[] = [
      { id: 'gw-c', protocolMap: { ollama: ['claude-sonnet'] } },
    ]
    const result = rewriteRefsForRename(providers, 'kimi-k3', 'kimi-k3-copy')
    expect(result.providers).toBe(providers)
    expect(result.explicitRefCount).toBe(0)
    expect(result.bareRefCount).toBe(0)
  })

  it('counts bare and explicit refs separately and keeps untouched providers by reference', () => {
    const untouched: AiProviderEntry = { id: 'gw-u', protocolMap: { ollama: ['m1'] } }
    const providers: readonly AiProviderEntry[] = [
      untouched,
      { id: 'gw-d', protocolMap: { ollama: ['kimi-k3', { id: 'wire-z', ref: 'kimi-k3' }] } },
    ]
    const result = rewriteRefsForRename(providers, 'kimi-k3', 'kimi-k3-copy')
    expect(result.explicitRefCount).toBe(1)
    expect(result.bareRefCount).toBe(1)
    expect(result.providers[0]).toBe(untouched)
  })
})

describe('modelKnowledgeUsage — finding who references a key', () => {
  it('returns nothing when no provider references the key', () => {
    const providers: readonly AiProviderEntry[] = [
      { id: 'gw-a', protocolMap: { ollama: ['claude-sonnet'] } },
      { id: 'gw-b' },
    ]
    expect(referencingProviders(providers, 'kimi-k3')).toEqual([])
  })

  it('dedupes one provider referenced across protocols', () => {
    const providers: readonly AiProviderEntry[] = [
      {
        id: 'gw-a',
        protocolMap: {
          'openai-chat': ['kimi-k3'],
          'anthropic-messages': [{ id: 'wire-x', ref: 'kimi-k3' }],
        },
      },
    ]
    expect(referencingProviders(providers, 'kimi-k3')).toEqual([
      { providerId: 'gw-a', explicit: true, bare: true },
    ])
  })

  it('reports bare for string shorthands and bare object ids', () => {
    const providers: readonly AiProviderEntry[] = [
      { id: 'gw-a', protocolMap: { ollama: ['kimi-k3'] } },
      { id: 'gw-b', protocolMap: { ollama: [{ id: 'kimi-k3' }] } },
    ]
    expect(referencingProviders(providers, 'kimi-k3')).toEqual([
      { providerId: 'gw-a', explicit: false, bare: true },
      { providerId: 'gw-b', explicit: false, bare: true },
    ])
  })

  it('reports a purely explicit reference as not bare', () => {
    const providers: readonly AiProviderEntry[] = [
      { id: 'gw-a', protocolMap: { ollama: [{ id: 'wire-x', ref: 'kimi-k3' }] } },
    ]
    expect(referencingProviders(providers, 'kimi-k3')).toEqual([
      { providerId: 'gw-a', explicit: true, bare: false },
    ])
  })

  it('reports both flags when a provider mixes bare and explicit references', () => {
    const providers: readonly AiProviderEntry[] = [
      {
        id: 'gw-a',
        protocolMap: { ollama: ['kimi-k3', { id: 'wire-x', ref: 'kimi-k3' }] },
      },
    ]
    // Both halves matter: one follows the rename, the other silently degrades.
    expect(referencingProviders(providers, 'kimi-k3')).toEqual([
      { providerId: 'gw-a', explicit: true, bare: true },
    ])
  })
})
