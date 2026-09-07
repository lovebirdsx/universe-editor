/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  inputTokensIncludeCached,
  isAnthropicCatalogModel,
  normalizeCatalogModelId,
} from '../catalog/index.js'

describe('isAnthropicCatalogModel', () => {
  it('recognises Anthropic ids, including date- and hint-suffixed ones', () => {
    expect(isAnthropicCatalogModel('claude-opus-4-20250514')).toBe(true)
    expect(isAnthropicCatalogModel('claude-sonnet-5[1m]')).toBe(true)
  })

  it('rejects gateway models that merely look Anthropic-ish', () => {
    expect(isAnthropicCatalogModel('kimi-k2.6')).toBe(false)
    expect(isAnthropicCatalogModel('claude-made-up')).toBe(false)
    expect(isAnthropicCatalogModel('gpt-5.5')).toBe(false)
  })
})

describe('normalizeCatalogModelId', () => {
  it('strips trailing context / effort hints', () => {
    expect(normalizeCatalogModelId('claude-sonnet-5[1m]')).toBe('claude-sonnet-5')
    expect(normalizeCatalogModelId('gpt-5.4-codex[high]')).toBe('gpt-5.4-codex')
  })

  it('strips trailing date suffixes', () => {
    expect(normalizeCatalogModelId('claude-opus-4-20250514')).toBe('claude-opus-4')
    expect(normalizeCatalogModelId('gpt-5.5-2026-01-15')).toBe('gpt-5.5')
  })

  it('lowercases and trims', () => {
    expect(normalizeCatalogModelId('  Claude-Sonnet-5  ')).toBe('claude-sonnet-5')
  })
})

describe('inputTokensIncludeCached', () => {
  it('follows the declared vendor on a catalog source', () => {
    expect(
      inputTokensIncludeCached('kimi-k2.6', { id: 'catalog', options: { vendor: 'moonshot' } }),
    ).toBe(true)
    expect(
      inputTokensIncludeCached('anything', { id: 'catalog', options: { vendor: 'deepseek' } }),
    ).toBe(false)
    expect(
      inputTokensIncludeCached('kimi-k2.6', { id: 'catalog', options: { vendor: 'anthropic' } }),
    ).toBe(false)
    expect(
      inputTokensIncludeCached('kimi-k2.6', { id: 'catalog', options: { vendor: 'openai' } }),
    ).toBe(false)
    expect(inputTokensIncludeCached('kimi-k2.6', { id: 'catalog', options: {} })).toBe(false)
  })

  it('falls back to exact built-in catalog membership on a gateway source', () => {
    const gw = { id: 'http-json', options: {} }
    expect(inputTokensIncludeCached('kimi-k3', gw)).toBe(true)
    expect(inputTokensIncludeCached('kimi-k3[1m]', gw)).toBe(true)
    expect(inputTokensIncludeCached('KIMI-K3', gw)).toBe(true)
    expect(inputTokensIncludeCached('acme-chat-pro', gw)).toBe(false)
    expect(inputTokensIncludeCached('claude-opus-4', gw)).toBe(false)
    expect(inputTokensIncludeCached('kimi-k3-renamed', gw)).toBe(false)
    expect(inputTokensIncludeCached('kimi')).toBe(false)
  })

  it('treats a missing pricing source as unknown — never deducts', () => {
    // A bare model name with no channel attribution proves nothing: even a
    // catalog member could be a renamed Anthropic-semantics deployment.
    expect(inputTokensIncludeCached('kimi-k3')).toBe(false)
    expect(inputTokensIncludeCached('claude-opus-4')).toBe(false)
  })

  it('honours the explicit options.inputTokens override over every other signal', () => {
    // The escape hatch: a renamed gateway deployment the catalog membership
    // check cannot recognize, or a mis-detected channel the user needs to fix
    // without waiting for a release.
    expect(
      inputTokensIncludeCached('kimi-k3-renamed', {
        id: 'http-json',
        options: { inputTokens: 'include-cached' },
      }),
    ).toBe(true)
    expect(
      inputTokensIncludeCached('kimi-k3', {
        id: 'http-json',
        options: { inputTokens: 'exclude-cached' },
      }),
    ).toBe(false)
    expect(
      inputTokensIncludeCached('anything', {
        id: 'catalog',
        options: { vendor: 'moonshot', inputTokens: 'exclude-cached' },
      }),
    ).toBe(false)
    expect(
      inputTokensIncludeCached('anything', {
        id: 'catalog',
        options: { vendor: 'anthropic', inputTokens: 'include-cached' },
      }),
    ).toBe(true)
  })
})
