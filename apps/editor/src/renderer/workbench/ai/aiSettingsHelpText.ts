/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Help copy (markdown) shown by the "?" button on each AI settings category.
 *  The default message is English (the NLS fallback); the Chinese translation
 *  lives under the same key in apps/editor/src/shared/i18n/messages/zh-CN.ts.
 *  Rendering is done by the shared MarkdownView.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'

export function aiProvidersHelpText(): string {
  return localize(
    'aiSettings.help.providers',
    [
      '## Provider Configuration',
      '',
      'Each provider entry is one gateway endpoint — the connection (base URL + API key) plus a `protocolMap` declaring which wire protocols it speaks and which models each protocol exposes. The `protocolMap` has three states:',
      '',
      '- **Undeclared** — the entry serves no protocol yet (flagged as a problem).',
      '- **`[]`** — enumerate the model list from the endpoint itself.',
      '- **A non-empty list** — exactly these models; the endpoint is never contacted.',
      '',
      "Use **extends** to add several entries for the same gateway (e.g. different accounts): the child inherits the parent's `protocolMap` and only overrides the fields it sets itself.",
      '',
      "Each entry optionally declares a **pricing source** and an **account-usage source**: rates are always a function of (gateway, model), and usage belongs to the entry's key.",
      '',
      'A model declared here may **narrow** the capabilities its knowledge entry lists — a gateway translating a model to another protocol loses features, it never gains them — so a capability the knowledge base does not have cannot be switched on here.',
      '',
      'The API key is stored **plaintext** in aiSettings.json — a deliberate decision so the configuration syncs across machines (the file is chmod 0600 on POSIX). It is masked in the UI and never logged.',
      '',
      'Intrinsic model properties (token limits, capabilities, …) are **not** configured here — they live in the **Model Configuration** category.',
      '',
      'Collapsed sections and filters are remembered. To edit the raw configuration directly, use **Open aiSettings.json**.',
    ].join('\n'),
  )
}

export function aiModelKnowledgeHelpText(): string {
  return localize(
    'aiSettings.help.models',
    [
      '## Model Configuration',
      '',
      'The model **knowledge base**: one entry per logical model id, holding the intrinsic properties that do not change when a model is reached through a different gateway.',
      '',
      'Fields: `name` / `family` / `vendor` / `nativeProtocol` / `maxInputTokens` / `maxOutputTokens` / `capabilities` / `supportsReasoningEffort` / `parameters`.',
      '',
      'Your entries merge over the built-in catalog **per field** — set only what you want to override; deleting a field restores the built-in value.',
      '',
      "Pricing is deliberately absent: a rate is a function of (gateway, model), so it belongs to each provider's `pricingSource`.",
      '',
      'Renaming a key affects `protocolMap` references: entries with an explicit `ref` can be rewritten automatically, while bare-name references degrade to a model without knowledge.',
      '',
      'The four capabilities are `streaming` / `vision` / `promptCaching` / `toolCalling`. Ticking any box records all four, because a partial set would silently drop the flags the built-in entry declares.',
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
