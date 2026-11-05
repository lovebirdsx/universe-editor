/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Local slash commands live in the editor, not in the agent: they must be
 *  hidden whenever the capability (or a writable session) is absent, must win
 *  name collisions against the agent's advertised list, and must only intercept
 *  a draft that is exactly one command token.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import {
  LOCAL_SLASH_COMMANDS,
  buildLocalSlashCommands,
  matchLocalSlashCommand,
  mergeSlashCommands,
} from '../localSlashCommands.js'

function agentCommand(name: string, description = 'agent command'): AvailableCommand {
  return { name, description }
}

describe('buildLocalSlashCommands', () => {
  it('offers both commands for a writable session advertising both capabilities', () => {
    const commands = buildLocalSlashCommands({
      forkSupported: true,
      rewindSupported: true,
      readOnly: false,
    })
    expect(commands.map((command) => command.name)).toEqual(['fork', 'rewind'])
  })

  it('offers only the capabilities the agent advertises', () => {
    expect(
      buildLocalSlashCommands({
        forkSupported: false,
        rewindSupported: true,
        readOnly: false,
      }).map((command) => command.name),
    ).toEqual(['rewind'])
    expect(
      buildLocalSlashCommands({
        forkSupported: true,
        rewindSupported: false,
        readOnly: false,
      }).map((command) => command.name),
    ).toEqual(['fork'])
  })

  it('offers nothing for a read-only foreign preview', () => {
    expect(
      buildLocalSlashCommands({
        forkSupported: true,
        rewindSupported: true,
        readOnly: true,
      }),
    ).toEqual([])
  })
})

describe('mergeSlashCommands', () => {
  it('puts local commands first and drops agent commands with the same name', () => {
    const local = buildLocalSlashCommands({
      forkSupported: true,
      rewindSupported: true,
      readOnly: false,
    })
    const merged = mergeSlashCommands(
      [agentCommand('fork', 'agent fork'), agentCommand('/rewind'), agentCommand('explain')],
      local,
    )

    expect(merged.map((command) => command.name)).toEqual(['fork', 'rewind', 'explain'])
    expect(merged[0]?.description).toBe(
      LOCAL_SLASH_COMMANDS.find((command) => command.name === 'fork')?.description,
    )
  })

  it('returns the agent list untouched when no local command is available', () => {
    const agentCommands = [agentCommand('fork')]
    expect(mergeSlashCommands(agentCommands, [])).toBe(agentCommands)
  })
})

describe('matchLocalSlashCommand', () => {
  const both = buildLocalSlashCommands({
    forkSupported: true,
    rewindSupported: true,
    readOnly: false,
  })

  it('matches an exact single-token command case-insensitively', () => {
    expect(matchLocalSlashCommand('/fork', both)?.actionId).toBe(
      LOCAL_SLASH_COMMANDS.find((command) => command.name === 'fork')?.actionId,
    )
    expect(matchLocalSlashCommand('/REWIND', both)?.name).toBe('rewind')
    expect(matchLocalSlashCommand('  /fork  ', both)?.name).toBe('fork')
  })

  it('does not intercept commands carrying arguments or extra lines', () => {
    expect(matchLocalSlashCommand('/fork explain this', both)).toBeUndefined()
    expect(matchLocalSlashCommand('/rewind\nmore text', both)).toBeUndefined()
    expect(matchLocalSlashCommand('please /fork', both)).toBeUndefined()
    expect(matchLocalSlashCommand('fork', both)).toBeUndefined()
  })

  it('does not intercept a command the session does not currently offer', () => {
    const rewindOnly = buildLocalSlashCommands({
      forkSupported: false,
      rewindSupported: true,
      readOnly: false,
    })
    expect(matchLocalSlashCommand('/fork', rewindOnly)).toBeUndefined()
    expect(matchLocalSlashCommand('/rewind', rewindOnly)?.name).toBe('rewind')
  })
})
