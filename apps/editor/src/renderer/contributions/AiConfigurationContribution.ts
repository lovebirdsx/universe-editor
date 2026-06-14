/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AI configuration schema — registers the non-secret `ai.*` settings consumed by
 *  the AI model service: per-vendor baseUrl / defaultModel and global request
 *  defaults. API keys are NEVER declared here; they live in encrypted secret
 *  storage (ISecretStorageService), out of settings.json and the renderer.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'

export class AiConfigurationContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'ai',
        title: localize('settings.ai', 'AI'),
        properties: {
          'ai.ollama.baseUrl': {
            type: 'string',
            default: 'http://127.0.0.1:11434',
            description: localize(
              'settings.ai.ollama.baseUrl',
              'Base URL of the Ollama server used by the built-in Ollama provider.',
            ),
          },
          'ai.ollama.defaultModel': {
            type: 'string',
            default: '',
            description: localize(
              'settings.ai.ollama.defaultModel',
              'Default Ollama model id (e.g. "ollama/llama3") used when a request does not specify one.',
            ),
          },
          'ai.openai.baseUrl': {
            type: 'string',
            default: '',
            description: localize(
              'settings.ai.openai.baseUrl',
              'Base URL for an OpenAI-compatible endpoint. Leave empty to use the provider default. The API key is stored encrypted, never here.',
            ),
          },
          'ai.openai.defaultModel': {
            type: 'string',
            default: '',
            description: localize(
              'settings.ai.openai.defaultModel',
              'Default OpenAI model id used when a request does not specify one.',
            ),
          },
          'ai.request.temperature': {
            type: 'number',
            minimum: 0,
            maximum: 2,
            description: localize(
              'settings.ai.request.temperature',
              'Default sampling temperature applied to AI requests when the caller does not override it. Leave unset to use the provider default.',
            ),
          },
          'ai.request.maxTokens': {
            type: 'number',
            minimum: 1,
            description: localize(
              'settings.ai.request.maxTokens',
              'Default maximum number of tokens to generate per AI request when the caller does not override it. Leave unset to use the provider default.',
            ),
          },
        },
      }),
    )
  }
}
