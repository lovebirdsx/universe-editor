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
      'Configuration is split into two levels:',
      '',
      '- **Provider Types**: the protocol, the shared model catalog and the rates. Editing a rate here applies to every instance of that type.',
      '- **Provider Instances**: one gateway entry each — a base URL and an API key. Instances of the same type share its models and rates.',
      '',
      'Models enumerated from the endpoint are merged with the ones you declare by hand; hand-written entries win and float to the top. Some models expose parameters you can tune via **Configure** (e.g. temperature).',
      '',
      'Sections and cards can be collapsed, and model lists can be filtered — all are remembered.',
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

export function aiMcpServersHelpText(): string {
  return localize(
    'aiSettings.help.mcpServers',
    [
      '## MCP Servers',
      '',
      'MCP servers give agents extra tools. Each server appears once, with a badge per source defining it:',
      '',
      '- **user**: `<userData>/settings.json` — available in every workspace.',
      '- **workspace**: `.universe-editor/settings.json` — only for this folder.',
      '- **.mcp.json**: Claude-Code-compatible file at the workspace root (read-only here).',
      '- **vscode-user / vscode-ws**: VSCode-compatible settings files (read-only here).',
      '- **ext**: contributed by an installed extension (never written to a settings file).',
      '',
      'Sources compose **per server name**: the winning badge renders normally, shadowed ones are dimmed. Click a badge to open that source (edit dialog for user/workspace, the file otherwise).',
      '',
      'The two switches on the left are the default on/off, stored separately from the definitions: the person icon is the **user-level** default (all workspaces), the folder icon the **workspace-level** one (wins here). The workspace switch is three-state — click through on/off back to the dashed state to inherit again. The user-level switch appears only for servers that also exist at user level. The "disabled" badge always shows the combined effective state.',
      '',
      'The picker next to the prompt input can still enable or trim servers for that one session only — it never changes these defaults. The dot shows the live connection status reported by the active session.',
      'Changes apply to new sessions immediately; the active session reloads seamlessly when its server set changes.',
    ].join('\n'),
  )
}
