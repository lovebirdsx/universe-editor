/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiConfigurationContribution schema tests — the top level is
 *  `additionalProperties: false`, so a stale `groups`-only schema would flag
 *  every real `providerTypes` / `providers` key in aiSettings.json. These tests
 *  assert the new two-layer shape and validate a realistic aiSettings.json
 *  object against the built schema.
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

const MODEL_IDS = ['kuro/gbl/claude-sonnet-4.5', 'myOpenai/edge/gpt-5.4']

const SAMPLE_SETTINGS = {
  providerTypes: {
    kuro: {
      label: 'Kuro',
      protocol: 'anthropic-messages',
      pricingSource: { id: 'http-json', options: { path: '/v1/pricing', auth: true } },
      usageSource: {
        id: 'http-json',
        options: { path: '/api/user/self', fields: { used: 'used_quota', limit: 'quota' } },
      },
    },
    myOpenai: {
      protocol: 'openai-responses',
      defaultBaseUrl: 'https://gw.example.com/v1',
      requiresApiKey: true,
      models: [
        {
          id: 'gpt-5.4',
          protocol: 'openai-responses',
          pricing: { currency: 'USD', input: 1.25, output: 10, cacheRead: 0.25 },
        },
      ],
    },
  },
  providers: [
    {
      name: 'gbl',
      type: 'kuro',
      label: 'Kuro GBL',
      baseUrl: 'https://kuro.example.com',
      apiKey: 'sk-kuro-abc123',
      usageSource: { id: 'http-json', options: {} },
      settings: { 'kuro/gbl/claude-sonnet-4.5': { temperature: 0.7 } },
    },
  ],
  activeModels: {
    chat: 'kuro/gbl/claude-sonnet-4.5',
    inlineCompletion: 'myOpenai/edge/gpt-5.4',
  },
  agentSettings: { claude: { authentication: {} } },
}

describe('AiConfigurationContribution.buildSchema', () => {
  it('declares all four top-level properties (providerTypes / providers / activeModels / agentSettings)', () => {
    const schema = buildSchema([])
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'providerTypes',
      'providers',
      'activeModels',
      'agentSettings',
    ])
  })

  it('requires name and type on provider instances', () => {
    const providers = buildSchema([]).properties?.providers
    expect(providers?.type).toBe('array')
    const items = providers && providers.type === 'array' ? providers.items : undefined
    expect(items?.required).toEqual(['name', 'type'])
  })

  it('lists the four wire protocols as the type protocol enum', () => {
    const providerTypes = buildSchema([]).properties?.providerTypes
    expect(providerTypes?.additionalProperties).toBeTruthy()
    const typeSchema =
      providerTypes && typeof providerTypes.additionalProperties === 'object'
        ? providerTypes.additionalProperties
        : undefined
    expect(typeSchema?.required).toEqual(['protocol'])
    expect(typeSchema?.properties?.protocol?.enum).toEqual([
      'openai-chat',
      'openai-responses',
      'anthropic-messages',
      'ollama',
    ])
  })

  it('extends the model schema with protocol / baseUrl / pricing', () => {
    const items = buildSchema([]).properties?.providers
    const instanceSchema = items && items.type === 'array' ? items.items : undefined
    const modelSchema = instanceSchema?.properties?.models
    const modelItems = modelSchema && modelSchema.type === 'array' ? modelSchema.items : undefined
    expect(modelItems?.properties?.protocol?.enum).toContain('openai-responses')
    expect(modelItems?.properties?.baseUrl?.type).toBe('string')
    expect(modelItems?.properties?.pricing?.required).toEqual(['input', 'output'])
  })

  it('declares a pricing schema (USD/CNY currency, required input/output)', () => {
    const providerTypes = buildSchema([]).properties?.providerTypes
    const typeSchema =
      providerTypes && typeof providerTypes.additionalProperties === 'object'
        ? providerTypes.additionalProperties
        : undefined
    const pricing = typeSchema?.properties?.pricing
    expect(pricing?.required).toEqual(['input', 'output'])
    expect(pricing?.properties?.currency?.enum).toEqual(['USD', 'CNY'])
  })

  it('declares a remote source schema (required id)', () => {
    const providerTypes = buildSchema([]).properties?.providerTypes
    const typeSchema =
      providerTypes && typeof providerTypes.additionalProperties === 'object'
        ? providerTypes.additionalProperties
        : undefined
    expect(typeSchema?.properties?.pricingSource?.required).toEqual(['id'])
    expect(typeSchema?.properties?.usageSource?.required).toEqual(['id'])
  })

  it('validates a realistic aiSettings.json object with no errors', () => {
    const errors = validate(buildSchema(MODEL_IDS), SAMPLE_SETTINGS, '$')
    expect(errors).toEqual([])
  })

  it('flags the old groups shape (regression guard for the additionalProperties:false top level)', () => {
    const errors = validate(buildSchema([]), { groups: [] }, '$')
    expect(errors).toContain(`$: unexpected property 'groups'`)
  })

  it('omits the activeModels enum when no models are known', () => {
    const chat = buildSchema([]).properties?.activeModels?.properties?.chat
    expect(chat?.enum).toBeUndefined()
    const withIds = buildSchema(MODEL_IDS).properties?.activeModels?.properties?.chat
    expect(withIds?.enum).toEqual(MODEL_IDS)
  })
})
