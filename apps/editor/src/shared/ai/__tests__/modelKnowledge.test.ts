/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  modelKnowledge: knowledge carries no pricing, and official catalogs are split
 *  per vendor.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { BUILTIN_MODEL_KNOWLEDGE, OFFICIAL_CATALOGS } from '../catalog/modelKnowledge.js'

describe('BUILTIN_MODEL_KNOWLEDGE', () => {
  it('records real vendor + native protocol', () => {
    expect(BUILTIN_MODEL_KNOWLEDGE['claude-opus-4-8']?.vendor).toBe('anthropic')
    expect(BUILTIN_MODEL_KNOWLEDGE['claude-opus-4-8']?.nativeProtocol).toBe('anthropic-messages')
    expect(BUILTIN_MODEL_KNOWLEDGE['gpt-5.5']?.vendor).toBe('openai')
    expect(BUILTIN_MODEL_KNOWLEDGE['gpt-5.5']?.nativeProtocol).toBe('openai-chat')
  })

  it('never carries pricing', () => {
    for (const entry of Object.values(BUILTIN_MODEL_KNOWLEDGE)) {
      expect('pricing' in entry).toBe(false)
    }
  })
})

describe('OFFICIAL_CATALOGS', () => {
  it('splits by vendor', () => {
    expect(OFFICIAL_CATALOGS['anthropic']?.['claude-sonnet-5']?.input).toBe(3)
    expect(OFFICIAL_CATALOGS['openai']?.['gpt-5.4']?.output).toBe(15)
    expect(OFFICIAL_CATALOGS['deepseek']?.['acme-chat-pro']?.currency).toBe('CNY')
    expect(OFFICIAL_CATALOGS['moonshot']?.['kimi-k3']?.currency).toBe('CNY')
  })
})
