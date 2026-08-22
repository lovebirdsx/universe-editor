/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_TYPES,
  isAnthropicCatalogModel,
  lookupCatalogPricing,
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

describe('lookupCatalogPricing', () => {
  it('hits anthropic tiers by exact bare id', () => {
    expect(lookupCatalogPricing('claude-sonnet-5')).toEqual({
      input: 3,
      cacheWrite: 3.75,
      cacheRead: 0.3,
      output: 15,
    })
    expect(lookupCatalogPricing('claude-opus-4-8')?.output).toBe(25)
    expect(lookupCatalogPricing('claude-fable-5')?.output).toBe(50)
    expect(lookupCatalogPricing('claude-haiku-4-5')?.input).toBe(1)
  })

  it('reaches date-suffixed anthropic ids', () => {
    expect(lookupCatalogPricing('claude-opus-4-20250514')?.input).toBe(5)
    expect(lookupCatalogPricing('claude-3-5-haiku-20241022')?.input).toBe(1)
  })

  it('hits openai tiers, including unpriced variants', () => {
    expect(lookupCatalogPricing('gpt-5.4')).toEqual({ input: 2.5, output: 15, cacheRead: 0.25 })
    expect(lookupCatalogPricing('gpt-5.4-codex')?.output).toBe(15)
    expect(lookupCatalogPricing('gpt-5.5-codex')?.input).toBe(5)
  })

  it('hits moonshot with CNY preserved', () => {
    expect(lookupCatalogPricing('kimi-k3')).toEqual({
      currency: 'CNY',
      input: 20,
      output: 100,
      cacheRead: 2,
    })
  })

  it('hits deepseek with CNY preserved', () => {
    expect(lookupCatalogPricing('deepseek-v4-pro')).toEqual({
      currency: 'CNY',
      input: 12,
      output: 24,
      cacheRead: 1,
    })
  })

  it('returns undefined for unknown models and never degrades to a default tier', () => {
    expect(lookupCatalogPricing('claude-made-up-9')).toBeUndefined()
    expect(lookupCatalogPricing('gpt-9.9')).toBeUndefined()
    expect(lookupCatalogPricing('')).toBeUndefined()
    expect(lookupCatalogPricing('claude-made-up-9')).not.toEqual({
      input: 3,
      cacheWrite: 3.75,
      cacheRead: 0.3,
      output: 15,
    })
  })
})

describe('BUILTIN_PROVIDER_TYPES', () => {
  it('declares the anthropic type', () => {
    const anthropic = BUILTIN_PROVIDER_TYPES['anthropic']!
    expect(anthropic.protocol).toBe('anthropic-messages')
    expect(anthropic.requiresApiKey).toBe(true)
    expect(anthropic.defaultBaseUrl).toBe('https://api.anthropic.com')
  })

  it('declares the openai type', () => {
    const openai = BUILTIN_PROVIDER_TYPES['openai']!
    expect(openai.protocol).toBe('openai-chat')
    expect(openai.requiresApiKey).toBe(true)
    expect(openai.defaultBaseUrl).toBe('https://api.openai.com/v1')
  })

  it('declares the ollama type with no api key', () => {
    const ollama = BUILTIN_PROVIDER_TYPES['ollama']!
    expect(ollama.protocol).toBe('ollama')
    expect(ollama.requiresApiKey).toBe(false)
    expect(ollama.defaultBaseUrl).toBe('http://127.0.0.1:11434')
  })
})
