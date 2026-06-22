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
          'ai.nes.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.ai.nes.enabled',
              'Enable Next Edit Suggestions: predict the next edit elsewhere in the file from your recent edits, shown as an inline diff you can jump to and accept with Tab.',
            ),
          },
          'ai.nes.recentEditsCount': {
            type: 'number',
            default: 10,
            minimum: 1,
            description: localize(
              'settings.ai.nes.recentEditsCount',
              'How many of your most recent edits per file are sent as context for Next Edit Suggestions.',
            ),
          },
          'ai.nes.contextLines': {
            type: 'number',
            default: 80,
            minimum: 0,
            description: localize(
              'settings.ai.nes.contextLines',
              'Number of lines above and below the cursor sent as document context for Next Edit Suggestions (ignored when ai.nes.includeFullDocument is on).',
            ),
          },
          'ai.nes.includeFullDocument': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.ai.nes.includeFullDocument',
              'Send the entire document as context for Next Edit Suggestions instead of a window around the cursor.',
            ),
          },
          'ai.nes.debounceDelay': {
            type: 'number',
            default: 400,
            minimum: 0,
            description: localize(
              'settings.ai.nes.debounceDelay',
              'Delay in milliseconds before an automatically-triggered Next Edit Suggestion request is sent.',
            ),
          },
          'ai.nes.maxTokens': {
            type: 'number',
            default: 512,
            minimum: 1,
            description: localize(
              'settings.ai.nes.maxTokens',
              'Maximum number of tokens to generate for a single Next Edit Suggestion.',
            ),
          },
          'ai.nes.fallbackToCompletion': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.ai.nes.fallbackToCompletion',
              'When a Next Edit Suggestion produces nothing, fall back to a cursor-position ghost-text completion.',
            ),
          },
        },
      }),
    )
  }
}
