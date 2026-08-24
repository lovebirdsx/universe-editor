/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in provider templates for the AddProvider dialog. Each template seeds
 *  the form with a known endpoint, protocol map, and pricing source so the user
 *  does not have to know the catalog-vendor wiring by heart. `id` and `apiKey`
 *  are never supplied by a template — they are always user input.
 *--------------------------------------------------------------------------------------------*/

import type { AiProviderEntry } from '@universe-editor/platform'

export interface AiProviderTemplate {
  readonly id: string
  readonly label: string
  readonly description: string
  /** id and apiKey are never supplied by a template. */
  readonly entry: Omit<AiProviderEntry, 'id' | 'apiKey'>
}

export const PROVIDER_TEMPLATES: readonly AiProviderTemplate[] = [
  {
    id: 'openai-official',
    label: 'OpenAI (official)',
    description: 'api.openai.com — GPT family, official rates',
    entry: {
      baseUrl: 'https://api.openai.com/v1',
      defaultProtocol: 'openai-chat',
      protocolMap: { 'openai-chat': [], 'openai-responses': [] },
      pricingSource: { id: 'catalog', options: { vendor: 'openai' } },
    },
  },
  {
    id: 'anthropic-official',
    label: 'Anthropic (official)',
    description: 'api.anthropic.com — Claude family, official rates',
    entry: {
      baseUrl: 'https://api.anthropic.com',
      defaultProtocol: 'anthropic-messages',
      protocolMap: { 'anthropic-messages': [] },
      pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'api.deepseek.com — DeepSeek family, official rates',
    entry: {
      baseUrl: 'https://api.deepseek.com/v1',
      defaultProtocol: 'openai-chat',
      protocolMap: { 'openai-chat': [] },
      pricingSource: { id: 'catalog', options: { vendor: 'deepseek' } },
    },
  },
  {
    id: 'ollama-local',
    label: 'Ollama (local)',
    description: 'localhost:11434 — local models, no API key needed',
    entry: {
      baseUrl: 'http://localhost:11434',
      defaultProtocol: 'ollama',
      protocolMap: { ollama: [] },
    },
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible gateway',
    description: 'Any OpenAI-compatible endpoint (LM Studio, vLLM, one-api, …)',
    entry: {
      defaultProtocol: 'openai-chat',
      protocolMap: { 'openai-chat': [] },
    },
  },
  {
    id: 'custom',
    label: 'Custom (blank)',
    description: 'Start from an empty form',
    entry: {},
  },
]
