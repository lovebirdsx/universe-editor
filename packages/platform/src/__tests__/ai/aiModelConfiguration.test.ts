/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiModelConfiguration.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  bareModelName,
  buildModelConfigSchema,
  composeModelId,
  parseModelRef,
} from '../../ai/aiModelConfiguration.js'

describe('parseModelRef', () => {
  it('parses providerId / protocol / channelModel', () => {
    expect(parseModelRef('kuro/openai-chat/deepseek-v4-pro')).toEqual({
      providerId: 'kuro',
      protocol: 'openai-chat',
      channelModel: 'deepseek-v4-pro',
    })
  })

  it('keeps any remaining / in the channel model, which gateways do use', () => {
    expect(parseModelRef('kuro/anthropic-messages/anthropic/claude-opus-4-8')).toEqual({
      providerId: 'kuro',
      protocol: 'anthropic-messages',
      channelModel: 'anthropic/claude-opus-4-8',
    })
  })

  it('rejects a stale two-layer id rather than inventing a provider', () => {
    // 'default' was the instance name under the retired type/instance/model grammar.
    expect(parseModelRef('anthropic/default/claude-sonnet')).toBeUndefined()
    expect(parseModelRef('openai/gbl/gpt-4o')).toBeUndefined()
  })

  it('returns undefined for a malformed id', () => {
    expect(parseModelRef('openai-chat/gpt-4o')).toBeUndefined()
    expect(parseModelRef('gpt-4o')).toBeUndefined()
    expect(parseModelRef('/openai-chat/gpt-4o')).toBeUndefined()
    expect(parseModelRef('kuro//gpt-4o')).toBeUndefined()
    expect(parseModelRef('kuro/openai-chat/')).toBeUndefined()
  })
})

describe('model id helpers', () => {
  it('composeModelId / bareModelName / parseModelRef round-trip', () => {
    const id = composeModelId('kuro', 'anthropic-messages', 'anthropic/claude-opus')
    expect(id).toBe('kuro/anthropic-messages/anthropic/claude-opus')
    expect(bareModelName(id, 'kuro', 'anthropic-messages')).toBe('anthropic/claude-opus')

    const ref = parseModelRef(id)
    expect(ref).toBeDefined()
    if (ref) expect(composeModelId(ref.providerId, ref.protocol, ref.channelModel)).toBe(id)
  })

  it('bareModelName leaves an id that does not carry the expected prefix alone', () => {
    expect(bareModelName('gpt-4o', 'kuro', 'openai-chat')).toBe('gpt-4o')
    expect(bareModelName('other/openai-chat/gpt-4o', 'kuro', 'openai-chat')).toBe(
      'other/openai-chat/gpt-4o',
    )
  })
})

describe('buildModelConfigSchema', () => {
  it('returns undefined when the model declares nothing tunable', () => {
    expect(buildModelConfigSchema({})).toBeUndefined()
  })

  it('turns supportsReasoningEffort into a navigation enum', () => {
    const schema = buildModelConfigSchema({ supportsReasoningEffort: ['low', 'high'] })
    expect(schema?.reasoningEffort).toMatchObject({
      type: 'enum',
      enum: ['low', 'high'],
      group: 'navigation',
    })
  })

  it('merges declared parameters over the base schema', () => {
    const schema = buildModelConfigSchema(
      { parameters: { top_k: { type: 'number', default: 40 } } },
      { temperature: { type: 'number', default: 1 } },
    )
    expect(Object.keys(schema ?? {}).sort()).toEqual(['temperature', 'top_k'])
    expect(schema?.top_k).toEqual({ type: 'number', default: 40 })
  })
})
