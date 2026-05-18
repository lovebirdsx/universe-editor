/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Builds a JSON Schema for keybindings.json from the live CommandsRegistry.
 *  Used by JsonSchemaBridgeContribution to feed Monaco's JSON language service
 *  with completion + hover docs for every registered command id.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry, type IJSONSchema } from '@universe-editor/platform'

export function buildKeybindingsJsonSchema(): IJSONSchema {
  const commandIds: string[] = []
  const descriptions: string[] = []

  for (const [id, cmd] of CommandsRegistry.getCommands()) {
    commandIds.push(id)
    descriptions.push(cmd.metadata?.description ?? cmd.metadata?.category ?? id)
  }

  // Sort for deterministic completion order.
  const sortedIdx = commandIds
    .map((_, i) => i)
    .sort((a, b) => commandIds[a]!.localeCompare(commandIds[b]!))
  const sortedIds = sortedIdx.map((i) => commandIds[i]!)
  const sortedDescs = sortedIdx.map((i) => descriptions[i]!)

  // Include "-id" removal variants so the existing template scaffolding
  // ("Prefix command with '-' to disable a default binding") completes too.
  const allIds = [...sortedIds, ...sortedIds.map((id) => `-${id}`)]
  const allDescs = [...sortedDescs, ...sortedDescs.map((d) => `Remove default binding (${d})`)]

  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Keybinding chord, e.g. "ctrl+shift+p" or "ctrl+k ctrl+s".',
        },
        command: {
          type: 'string',
          description: 'Command id to invoke. Prefix with "-" to remove a default binding.',
          enum: allIds,
          enumDescriptions: allDescs,
        },
        when: {
          type: 'string',
          description: 'Context-key expression that gates this binding.',
        },
        args: {
          description: 'Arguments forwarded to the command handler.',
        },
      },
      required: ['key', 'command'],
      additionalProperties: false,
    },
  }
}
