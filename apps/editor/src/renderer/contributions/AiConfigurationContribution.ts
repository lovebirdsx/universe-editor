/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the JSON schema for aiModels.json (the provider-group configuration
 *  file), so editing it gets completion + validation in Monaco. The non-secret
 *  AI configuration now lives in this dedicated file rather than settings.json;
 *  API keys are NEVER part of it — they live in encrypted secret storage.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkbenchContribution,
  JSONContributionRegistry,
  type IJSONSchema,
} from '@universe-editor/platform'

const AI_MODELS_SCHEMA_URI = 'universe-editor://schemas/ai/models'

const MODEL_SCHEMA: IJSONSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', description: 'Bare model id the endpoint expects, e.g. "qwen3-coder".' },
    name: { type: 'string', description: 'Display name.' },
    family: { type: 'string', description: 'Model family, e.g. "gpt-4o".' },
    maxInputTokens: { type: 'number', description: 'Maximum input context size, in tokens.' },
    maxOutputTokens: { type: 'number', description: 'Maximum number of tokens to generate.' },
    capabilities: {
      type: 'object',
      properties: {
        streaming: { type: 'boolean' },
        vision: { type: 'boolean' },
        toolCalling: { type: 'boolean' },
      },
    },
    supportsReasoningEffort: {
      type: 'array',
      items: { type: 'string' },
      description: 'Reasoning-effort levels this model accepts (drives a reasoningEffort setting).',
    },
  },
}

const GROUP_SCHEMA: IJSONSchema = {
  type: 'object',
  required: ['name', 'vendor'],
  properties: {
    name: {
      type: 'string',
      description: "Group name, unique within a vendor (must not contain '/').",
    },
    vendor: {
      type: 'string',
      description: 'Vendor this group binds to, e.g. "openai" or "ollama".',
    },
    baseUrl: {
      type: 'string',
      description: "Endpoint override; falls back to the provider's default.",
    },
    models: {
      type: 'array',
      description: 'Hand-declared models, merged with whatever the endpoint enumerates.',
      items: MODEL_SCHEMA,
    },
    settings: {
      type: 'object',
      description: 'Per-model configuration, keyed by full model id (vendor/group/model).',
      additionalProperties: { type: 'object' },
    },
  },
}

const AI_MODELS_SCHEMA: IJSONSchema = {
  type: 'array',
  items: GROUP_SCHEMA,
}

export class AiConfigurationContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      JSONContributionRegistry.registerSchema({
        uri: AI_MODELS_SCHEMA_URI,
        fileMatch: ['**/aiModels.json'],
        schema: AI_MODELS_SCHEMA,
      }),
    )
  }
}
