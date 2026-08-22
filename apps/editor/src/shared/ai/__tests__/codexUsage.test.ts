/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import {
  CODEX_UNKNOWN_MODEL,
  extractCodexModelUsage,
  extractCodexTurnUsage,
} from '../codexUsage.js'

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

  it('buckets the flat usage field under the unknown-model id', () => {
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
      { model: CODEX_UNKNOWN_MODEL, inputTokens: 50, cachedReadTokens: 10, outputTokens: 70 },
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

  it('buckets a model-less entry under the unknown-model id', () => {
    const meta = {
      quota: {
        model_usage: [
          {
            token_count: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 200 },
          },
        ],
      },
    }

    expect(extractCodexModelUsage(meta)).toEqual([
      {
        model: CODEX_UNKNOWN_MODEL,
        inputTokens: 100,
        cachedReadTokens: 40,
        outputTokens: 200,
      },
    ])
  })

  it('returns [] for absent / malformed meta', () => {
    expect(extractCodexModelUsage(undefined)).toEqual([])
    expect(extractCodexModelUsage(null)).toEqual([])
    expect(extractCodexModelUsage({})).toEqual([])
    expect(extractCodexModelUsage({ quota: { model_usage: 'nope' } })).toEqual([])
  })
})
