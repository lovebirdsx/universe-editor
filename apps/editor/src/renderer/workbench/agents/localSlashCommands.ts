/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Local slash commands for the agent prompt input. Unlike the commands the
 *  agent advertises via `available_commands_update`, these are executed by the
 *  editor itself and never become prompt text. They are merged ahead of the
 *  agent's list and match only when the whole draft is exactly one command token
 *  — `/fork explain this` stays a normal prompt.
 *--------------------------------------------------------------------------------------------*/

import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { localize } from '@universe-editor/platform'
import {
  ForkAgentSessionAction,
  RewindAgentSessionAction,
} from '../../actions/agentRewindActions.js'

export interface LocalSlashCommandSpec {
  readonly name: 'fork' | 'rewind'
  readonly actionId: string
  readonly description: string
}

export const LOCAL_SLASH_COMMANDS: readonly LocalSlashCommandSpec[] = [
  {
    name: 'fork',
    actionId: ForkAgentSessionAction.ID,
    description: localize('acp.localSlash.fork.description', 'Fork this session from a message'),
  },
  {
    name: 'rewind',
    actionId: RewindAgentSessionAction.ID,
    description: localize(
      'acp.localSlash.rewind.description',
      'Rewind this session to an earlier message',
    ),
  },
]

function normalizeName(name: string): string {
  return name.replace(/^\//, '').toLowerCase()
}

export function buildLocalSlashCommands(availability: {
  readonly forkSupported: boolean
  readonly rewindSupported: boolean
  readonly readOnly: boolean
}): readonly AvailableCommand[] {
  if (availability.readOnly) return []
  const enabled = new Set<LocalSlashCommandSpec['name']>()
  if (availability.forkSupported) enabled.add('fork')
  if (availability.rewindSupported) enabled.add('rewind')
  return LOCAL_SLASH_COMMANDS.filter((command) => enabled.has(command.name)).map((command) => ({
    name: command.name,
    description: command.description,
  }))
}

/**
 * Local commands win name collisions: the editor's fork/rewind are fixed
 * semantics, while an agent's same-named command has no protocol standard.
 */
export function mergeSlashCommands(
  agentCommands: readonly AvailableCommand[],
  localCommands: readonly AvailableCommand[],
): readonly AvailableCommand[] {
  if (localCommands.length === 0) return agentCommands
  const localNames = new Set(localCommands.map((command) => normalizeName(command.name)))
  return [
    ...localCommands,
    ...agentCommands.filter((command) => !localNames.has(normalizeName(command.name))),
  ]
}

/** Match only an exact single-token command; arguments/multiline text stay prompts. */
export function matchLocalSlashCommand(
  text: string,
  localCommands: readonly AvailableCommand[],
): LocalSlashCommandSpec | undefined {
  const match = /^\/([A-Za-z0-9_-]+)$/.exec(text.trim())
  const name = match?.[1]?.toLowerCase()
  if (name === undefined) return undefined
  if (!localCommands.some((command) => normalizeName(command.name) === name)) return undefined
  return LOCAL_SLASH_COMMANDS.find((command) => command.name === name)
}
