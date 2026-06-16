/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the ai.inlineCompletion.* settings that drive the AI ghost-text
 *  completions. These control whether AI requests are issued and how context is
 *  built; Monaco's own editor.inlineSuggest.* options (which control ghost-text
 *  rendering) are separate and registered by the generated editor-option schema.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'

export class InlineCompletionConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'ai',
        title: localize('settings.ai', 'AI'),
        properties: {
          'ai.inlineCompletion.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.ai.inlineCompletion.enabled',
              'Enable AI inline completions (ghost text) while editing.',
            ),
          },
          'ai.inlineCompletion.model': {
            type: 'string',
            default: '',
            description: localize(
              'settings.ai.inlineCompletion.model',
              'The AI model id used for inline completions (e.g. "openai/default/gpt-4o"). Leave empty to pick one from the status bar or the "Inline Completion: Select Model" command.',
            ),
          },
          'ai.inlineCompletion.debounceDelay': {
            type: 'number',
            default: 300,
            minimum: 0,
            description: localize(
              'settings.ai.inlineCompletion.debounceDelay',
              'Delay in milliseconds before an automatically-triggered inline completion request is sent.',
            ),
          },
          'ai.inlineCompletion.maxContextPrefixChars': {
            type: 'number',
            default: 2000,
            minimum: 0,
            description: localize(
              'settings.ai.inlineCompletion.maxContextPrefixChars',
              'Maximum number of characters before the cursor sent as context.',
            ),
          },
          'ai.inlineCompletion.maxContextSuffixChars': {
            type: 'number',
            default: 500,
            minimum: 0,
            description: localize(
              'settings.ai.inlineCompletion.maxContextSuffixChars',
              'Maximum number of characters after the cursor sent as context.',
            ),
          },
          'ai.inlineCompletion.maxTokens': {
            type: 'number',
            default: 128,
            minimum: 1,
            description: localize(
              'settings.ai.inlineCompletion.maxTokens',
              'Maximum number of tokens to generate for a single inline completion.',
            ),
          },
          'ai.inlineCompletion.multiline': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.ai.inlineCompletion.multiline',
              'Allow inline completions to span multiple lines. When off, completions are truncated to a single line.',
            ),
          },
          'ai.inlineCompletion.disabledLanguages': {
            type: 'array',
            items: { type: 'string' },
            default: [],
            description: localize(
              'settings.ai.inlineCompletion.disabledLanguages',
              'Language ids for which AI inline completions are disabled, e.g. ["json", "log"].',
            ),
          },
        },
      }),
    )
  }
}
