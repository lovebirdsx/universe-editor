/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiConfigurationContribution schema tests — the top level is
 *  `additionalProperties: false`, so a stale two-layer schema would flag every
 *  real `models` / `providers` / `modelSettings` key in aiSettings.json. These
 *  tests assert the new single-layer shape (knowledge base / provider entries /
 *  top-level modelSettings / single-string agent authentication) and validate a
 *  realistic aiSettings.json object against the built schema.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IJSONSchema } from '@universe-editor/platform'
import { buildSchema } from '../AiConfigurationContribution.js'

/**
 * A minimal JSON-Schema validator covering the subset this schema uses. Real
 * enough to catch the `additionalProperties: false` regression and missing
 * `required` keys, without pulling in a full validator dependency.
 */
function validate(schema: IJSONSchema, value: unknown, path: string): string[] {
  const errors: string[] = []
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`)
      return errors
    }
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required '${key}'`)
    }
    for (const [key, val] of Object.entries(obj)) {
      const propSchema = schema.properties?.[key]
      if (propSchema) {
        errors.push(...validate(propSchema, val, `${path}.${key}`))
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property '${key}'`)
      } else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, val, `${path}.${key}`))
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`)
      return errors
    }
    const items = schema.items
    if (!items) return errors
    value.forEach((item, i) => {
      errors.push(...validate(items, item, `${path}[${i}]`))
    })
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: expected string`)
    else if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path}: '${value}' not in enum`)
    }
  } else if (schema.type === 'number') {
    if (typeof value !== 'number') errors.push(`${path}: expected number`)
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path}: expected boolean`)
  }
  return errors
}

const MODEL_IDS = [
  'acme-gbl/anthropic-messages/acme-chat-pro',
  'acme-gbl/openai-chat/acme-chat-standard',
]

const SAMPLE_SETTINGS = {
  models: {
    'acme-chat-pro': {
      name: 'Acme Chat Pro',
      vendor: 'deepseek',
      nativeProtocol: 'openai-chat',
      maxInputTokens: 128000,
      maxOutputTokens: 32000,
      capabilities: { streaming: true, vision: true },
      supportsReasoningEffort: ['low'],
      parameters: { temperature: { type: 'number' } },
    },
  },
  providers: [
    {
      id: 'acme',
      baseUrl: 'https://api.acme.example/v1',
      apiKey: 'key-xxxx',
      defaultProtocol: 'openai-chat',
      protocolMap: {
        'openai-chat': ['acme-chat-pro', 'acme-chat-standard'],
        'anthropic-messages': [
          'acme-chat-pro',
          {
            id: 'anthropic/claude-opus-4-8',
            ref: 'claude-opus-4-8',
            capabilities: { promptCaching: false },
          },
        ],
      },
      pricingSource: { id: 'http-json', options: { path: '/v1/pricing', currency: 'CNY' } },
      usageSource: { id: 'http-json', options: { path: '/v1/quota' } },
    },
    { id: 'acme-gbl', extends: 'acme', baseUrl: 'http://192.0.2.31:8080/v1', apiKey: 'ak-...' },
  ],
  modelSettings: { 'acme-gbl/anthropic-messages/acme-chat-pro': { temperature: 0.3 } },
  activeModels: {
    chat: 'acme-gbl/anthropic-messages/acme-chat-pro',
    inlineCompletion: 'acme-gbl/openai-chat/acme-chat-standard',
  },
  agentSettings: {
    claude: { authentication: 'acme-gbl', model: 'acme-chat-pro' },
    codex: { authentication: '@subscription' },
  },
}

describe('AiConfigurationContribution.buildSchema', () => {
  it('declares all five top-level properties (models / providers / modelSettings / activeModels / agentSettings)', () => {
    const schema = buildSchema([])
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'models',
      'providers',
      'modelSettings',
      'activeModels',
      'agentSettings',
    ])
  })

  it('requires id on provider entries', () => {
    const providers = buildSchema([]).properties?.providers
    expect(providers?.type).toBe('array')
    const items = providers && providers.type === 'array' ? providers.items : undefined
    expect(items?.required).toEqual(['id'])
  })

  it('lists the four wire protocols as the defaultProtocol enum', () => {
    const items = buildSchema([]).properties?.providers
    const entry = items && items.type === 'array' ? items.items : undefined
    const props = entry && entry.type === 'object' ? entry.properties : undefined
    expect(props?.defaultProtocol?.enum).toEqual([
      'openai-chat',
      'openai-responses',
      'anthropic-messages',
      'ollama',
    ])
  })

  it('models the knowledge-base entry with capabilities and the parameters field', () => {
    const models = buildSchema([]).properties?.models
    const knowledge =
      models && typeof models.additionalProperties === 'object'
        ? models.additionalProperties
        : undefined
    expect(knowledge?.properties?.capabilities?.properties?.promptCaching?.type).toBe('boolean')
    expect(knowledge?.properties?.parameters?.type).toBe('object')
  })

  it('declares a remote source schema (required id) on provider entries', () => {
    const items = buildSchema([]).properties?.providers
    const entry = items && items.type === 'array' ? items.items : undefined
    const props = entry && entry.type === 'object' ? entry.properties : undefined
    expect(props?.pricingSource?.required).toEqual(['id'])
    expect(props?.usageSource?.required).toEqual(['id'])
  })

  it('declares agent authentication as a single string', () => {
    const agentSettings = buildSchema([]).properties?.agentSettings
    const agent =
      agentSettings && typeof agentSettings.additionalProperties === 'object'
        ? agentSettings.additionalProperties
        : undefined
    expect(agent?.properties?.authentication?.type).toBe('string')
  })

  it('validates a realistic aiSettings.json object with no errors', () => {
    const errors = validate(buildSchema(MODEL_IDS), SAMPLE_SETTINGS, '$')
    expect(errors).toEqual([])
  })

  it('flags the retired two-layer shapes (regression guard for the additionalProperties:false top level)', () => {
    const groups = validate(buildSchema([]), { groups: [] }, '$')
    expect(groups).toContain(`$: unexpected property 'groups'`)
    const types = validate(buildSchema([]), { providerTypes: {} }, '$')
    expect(types).toContain(`$: unexpected property 'providerTypes'`)
  })

  it('omits the activeModels enum when no models are known', () => {
    const chat = buildSchema([]).properties?.activeModels?.properties?.chat
    expect(chat?.enum).toBeUndefined()
    const withIds = buildSchema(MODEL_IDS).properties?.activeModels?.properties?.chat
    expect(withIds?.enum).toEqual(MODEL_IDS)
  })
})
