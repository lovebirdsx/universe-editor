/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in OpenAI model catalog. Rates are USD per 1M tokens, keyed by exact
 *  bare model id. OpenAI bills prompt-cache reads at a discount but has no
 *  separate cache-write tier, so cacheWrite is omitted (platform defaults it to
 *  the input rate, and codex never reports cache-write tokens anyway).
 *--------------------------------------------------------------------------------------------*/

import type { AiCustomModelConfig, AiModelPricing, AiRateTable } from '@universe-editor/platform'

const GPT_5_2_PRICING: AiModelPricing = { input: 1.75, output: 14, cacheRead: 0.175 }
const GPT_5_3_PRICING: AiModelPricing = { input: 1.75, output: 14, cacheRead: 0.175 }
const GPT_5_4_PRICING: AiModelPricing = { input: 2.5, output: 15, cacheRead: 0.25 }
const GPT_5_4_MINI_PRICING: AiModelPricing = { input: 0.75, output: 4.5, cacheRead: 0.075 }
const GPT_5_4_NANO_PRICING: AiModelPricing = { input: 0.2, output: 1.25, cacheRead: 0.02 }
const GPT_5_4_PRO_PRICING: AiModelPricing = { input: 30, output: 180, cacheRead: 0 }
const GPT_5_5_PRICING: AiModelPricing = { input: 5, output: 30, cacheRead: 0.5 }
const GPT_5_6_LUNA_PRICING: AiModelPricing = { input: 1, output: 6, cacheRead: 0.1 }
const GPT_5_6_SOL_PRICING: AiModelPricing = { input: 5, output: 30, cacheRead: 0.5 }
const GPT_5_6_TERRA_PRICING: AiModelPricing = { input: 2.5, output: 15, cacheRead: 0.25 }

export const OPENAI_CATALOG: AiRateTable = {
  'gpt-5.2': GPT_5_2_PRICING,
  'gpt-5.3-chat': GPT_5_3_PRICING,
  'gpt-5.3-codex': GPT_5_3_PRICING,
  'gpt-5.4': GPT_5_4_PRICING,
  'gpt-5.4-mini': GPT_5_4_MINI_PRICING,
  'gpt-5.4-nano': GPT_5_4_NANO_PRICING,
  'gpt-5.4-pro': GPT_5_4_PRO_PRICING,
  'gpt-5.4-codex': GPT_5_4_PRICING,
  'gpt-5.5': GPT_5_5_PRICING,
  'gpt-5.5-codex': GPT_5_5_PRICING,
  'gpt-5.6-luna': GPT_5_6_LUNA_PRICING,
  'gpt-5.6-sol': GPT_5_6_SOL_PRICING,
  'gpt-5.6-terra': GPT_5_6_TERRA_PRICING,
}

export const OPENAI_MODELS: readonly AiCustomModelConfig[] = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    family: 'gpt-5.4',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    capabilities: { streaming: true, vision: true },
    supportsReasoningEffort: ['low', 'medium', 'high'],
    pricing: GPT_5_4_PRICING,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    family: 'gpt-5.4-mini',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    capabilities: { streaming: true, vision: true },
    pricing: GPT_5_4_MINI_PRICING,
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    family: 'gpt-5.5',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    capabilities: { streaming: true, vision: true },
    supportsReasoningEffort: ['low', 'medium', 'high'],
    pricing: GPT_5_5_PRICING,
  },
]
