/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { isAnthropicCatalogModel, normalizeCatalogModelId } from '../catalog/index.js'

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
