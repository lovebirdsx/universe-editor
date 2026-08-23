/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Anthropic model catalog. Rates are USD per 1M tokens, keyed by
 *  exact bare model id — no family guessing and no default tier.
 *--------------------------------------------------------------------------------------------*/

import type { AiModelKnowledge, AiModelPricing, AiRateTable } from '@universe-editor/platform'

const FABLE_PRICING: AiModelPricing = { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 }
const OPUS_PRICING: AiModelPricing = { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }
const SONNET_PRICING: AiModelPricing = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }
const HAIKU_PRICING: AiModelPricing = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }

export const ANTHROPIC_CATALOG: AiRateTable = {
  'claude-fable-5': FABLE_PRICING,
  'claude-opus-4-8': OPUS_PRICING,
  'claude-opus-4-6': OPUS_PRICING,
  'claude-opus-4-20250514': OPUS_PRICING,
  'claude-sonnet-5': SONNET_PRICING,
  'claude-sonnet-4-6': SONNET_PRICING,
  'claude-sonnet-4-5': SONNET_PRICING,
  'claude-haiku-4-5': HAIKU_PRICING,
  'claude-3-5-haiku-20241022': HAIKU_PRICING,
}

// Rates are a (channel, model) function, never intrinsic model knowledge.
export const ANTHROPIC_MODEL_KNOWLEDGE: Readonly<Record<string, AiModelKnowledge>> = {
  'claude-fable-5': {
    name: 'Claude Fable 5',
    family: 'claude-fable',
    vendor: 'anthropic',
    nativeProtocol: 'anthropic-messages',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    capabilities: { streaming: true, vision: true },
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    family: 'claude-opus',
    vendor: 'anthropic',
    nativeProtocol: 'anthropic-messages',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    capabilities: { streaming: true, vision: true },
  },
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    family: 'claude-sonnet',
    vendor: 'anthropic',
    nativeProtocol: 'anthropic-messages',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    capabilities: { streaming: true, vision: true },
  },
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5',
    family: 'claude-haiku',
    vendor: 'anthropic',
    nativeProtocol: 'anthropic-messages',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    capabilities: { streaming: true, vision: true },
  },
}
