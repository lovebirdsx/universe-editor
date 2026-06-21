/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Help copy (markdown) shown by the "?" button on each AI settings category.
 *  The default message is English (the NLS fallback); the Chinese translation
 *  lives under the same key in apps/editor/src/shared/i18n/messages/zh-CN.ts.
 *  Rendering is done by the shared MarkdownView.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'

export function aiModelsHelpText(): string {
  return localize(
    'aiSettings.help.models',
    [
      '## Model Configuration',
      '',
      'Manage your AI service **provider groups** here. Each group is a configuration unit that holds:',
      '',
      '- **Base URL**: leave empty to use the provider default; point it at any OpenAI-compatible endpoint (LM Studio / vLLM / DeepSeek, …) to reuse the `openai` provider.',
      '- **API Key**: stored encrypted on this machine only — **never** written to `aiSettings.json`.',
      '- **Models**: models enumerated from the endpoint are merged with the ones you declare by hand; hand-written entries win and float to the top.',
      '',
      'Some models expose parameters you can tune via **Configure** (e.g. temperature).',
      'Each group can be collapsed, and its model list can be filtered — both are remembered.',
      'To edit the raw configuration directly, use **Open aiSettings.json**.',
    ].join('\n'),
  )
}

export function aiFeatureModelsHelpText(): string {
  return localize(
    'aiSettings.help.features',
    [
      '## Feature Models',
      '',
      'Assign a model to each AI feature independently:',
      '',
      '- **Chat**: the main model used by AGENTS sessions and chat completions.',
      '- **Inline Completion**: editor ghost-text suggestions (can be a smaller, faster model).',
      '- **Commit Message**: the model used to generate Git commit messages.',
      '',
      'Click any row to open the model picker; the selection takes effect immediately — the same experience as the status-bar model picker.',
    ].join('\n'),
  )
}

export function aiSystemPromptsHelpText(): string {
  return localize(
    'aiSettings.help.systemPrompts',
    [
      '## System Prompts',
      '',
      'Customize the **system prompt** sent to the model for each AI feature:',
      '',
      '- **Commit Message**: instructions for summarizing staged changes into a commit message.',
      '- **Inline Completion**: instructions for the Copilot-style ghost-text engine.',
      '- **Session Title**: instructions for naming AGENTS sessions.',
      '',
      'Leave a field empty to use the built-in default — shown as grey placeholder text. Use **Restore default** to clear an override you no longer want.',
      'Overrides are saved to `aiSettings.json`; built-in defaults are never written to the file.',
    ].join('\n'),
  )
}
