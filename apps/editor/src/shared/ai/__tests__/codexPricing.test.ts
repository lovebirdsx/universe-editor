/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import {
  codexModelFamily,
  codexModelPricing,
  estimateCodexCostUSD,
  extractCodexModelUsage,
  extractCodexTurnUsage,
} from '../codexPricing.js'

describe('codexModelFamily', () => {
  it('exact-matches priced families', () => {
    expect(codexModelFamily('gpt-5.4')).toBe('gpt-5.4')
    expect(codexModelFamily('gpt-5.5')).toBe('gpt-5.5')
    expect(codexModelFamily('gpt-5.4-mini')).toBe('gpt-5.4-mini')
    expect(codexModelFamily('gpt-5.4-nano')).toBe('gpt-5.4-nano')
    expect(codexModelFamily('gpt-5.4-pro')).toBe('gpt-5.4-pro')
    expect(codexModelFamily('gpt-5.3-codex')).toBe('gpt-5.3-codex')
  })

  it('strips reasoning-effort and date suffixes before matching', () => {
    expect(codexModelFamily('GPT-5.4-Mini[high]')).toBe('gpt-5.4-mini')
    expect(codexModelFamily('gpt-5.5-2026-01-15')).toBe('gpt-5.5')
    expect(codexModelFamily('gpt-5.4-pro[medium]')).toBe('gpt-5.4-pro')
  })

  it('folds an unpriced variant down to its version base tier', () => {
    expect(codexModelFamily('gpt-5.4-codex')).toBe('gpt-5.4')
    expect(codexModelFamily('gpt-5.5-codex')).toBe('gpt-5.5')
  })

  it('falls back to the default family for unknown ids', () => {
    expect(codexModelFamily('some-future-model')).toBe('gpt-5.4')
  })
})

describe('estimateCodexCostUSD', () => {
  it('bills input / cached / output at their respective per-million rates', () => {
    // gpt-5.4: input 2.5, cachedInput 0.25, output 15 per 1M tokens.
    const cost = estimateCodexCostUSD('gpt-5.4', {
      inputTokens: 1_000_000,
      cachedReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(2.5 + 0.25 + 15, 6)
  })

  it('discounts cached input relative to fresh input', () => {
    const p = codexModelPricing('gpt-5.4')
    expect(p.cachedInput).toBeLessThan(p.input)
  })

  it('returns zero for an empty tally', () => {
    expect(
      estimateCodexCostUSD('gpt-5.4', {
        inputTokens: 0,
        cachedReadTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0)
  })

  it('scales mini cheaper than the flagship for identical usage', () => {
    const tally = { inputTokens: 500_000, cachedReadTokens: 0, outputTokens: 200_000 }
    expect(estimateCodexCostUSD('gpt-5.4-mini', tally)).toBeLessThan(
      estimateCodexCostUSD('gpt-5.4', tally),
    )
  })
})

describe('extractCodexTurnUsage', () => {
  it('reads per-model usage from _meta.quota.model_usage', () => {
    const response = {
      stopReason: 'end_turn',
      _meta: {
        quota: {
          model_usage: [
            {
              model: 'gpt-5.4-codex',
              token_count: {
                inputTokens: 100,
                cachedInputTokens: 40,
                outputTokens: 200,
              },
            },
          ],
        },
      },
    } as unknown as PromptResponse

    expect(extractCodexTurnUsage(response)).toEqual([
      { model: 'gpt-5.4-codex', inputTokens: 100, cachedReadTokens: 40, outputTokens: 200 },
    ])
  })

  it('falls back to the flat usage field under the default-family bucket', () => {
    const response = {
      stopReason: 'end_turn',
      usage: {
        inputTokens: 50,
        cachedReadTokens: 10,
        outputTokens: 70,
        totalTokens: 130,
      },
    } as unknown as PromptResponse

    expect(extractCodexTurnUsage(response)).toEqual([
      { model: 'gpt-5.4', inputTokens: 50, cachedReadTokens: 10, outputTokens: 70 },
    ])
  })

  it('returns [] when no token data is present', () => {
    expect(extractCodexTurnUsage({ stopReason: 'end_turn' } as PromptResponse)).toEqual([])
    expect(
      extractCodexTurnUsage({
        stopReason: 'end_turn',
        usage: { inputTokens: 0, cachedReadTokens: 0, outputTokens: 0, totalTokens: 0 },
      } as unknown as PromptResponse),
    ).toEqual([])
  })
})

describe('extractCodexModelUsage', () => {
  it('parses session-cumulative per-model usage from a quota meta snapshot', () => {
    const meta = {
      quota: {
        token_count: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 200 },
        model_usage: [
          {
            model: 'gpt-5.4-mini',
            token_count: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 200 },
          },
        ],
      },
    }

    expect(extractCodexModelUsage(meta)).toEqual([
      { model: 'gpt-5.4-mini', inputTokens: 100, cachedReadTokens: 40, outputTokens: 200 },
    ])
  })

  it('returns [] for absent / malformed meta', () => {
    expect(extractCodexModelUsage(undefined)).toEqual([])
    expect(extractCodexModelUsage(null)).toEqual([])
    expect(extractCodexModelUsage({})).toEqual([])
    expect(extractCodexModelUsage({ quota: { model_usage: 'nope' } })).toEqual([])
  })

  it('matches the real per-call billing data within rounding (rate 7.0)', () => {
    // One model call from a real session: in 34,384 / out 2,286 / cache-read 31,104.
    // Provider billed ¥0.2688 for gpt-5.4-mini.
    const usage = extractCodexModelUsage({
      quota: {
        model_usage: [
          {
            model: 'gpt-5.4-mini',
            token_count: { inputTokens: 34_384, cachedInputTokens: 31_104, outputTokens: 2_286 },
          },
        ],
      },
    })
    const u = usage[0]!
    const usd = estimateCodexCostUSD(u.model, {
      inputTokens: u.inputTokens,
      cachedReadTokens: u.cachedReadTokens,
      outputTokens: u.outputTokens,
    })
    expect(usd * 7.0).toBeCloseTo(0.2688, 2)
  })
})
