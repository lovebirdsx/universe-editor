import { describe, expect, it } from 'vitest'
import type { MobileAvailableCommand } from '@universe-editor/mobile-protocol'
import {
  applySlashCommand,
  extractSlashQuery,
  filterSlashCommands,
  formatCommandName,
} from '../slashCommands.js'

function command(name: string, description = ''): MobileAvailableCommand {
  return { name, description }
}

describe('extractSlashQuery', () => {
  it('detects a bare slash and a partial first token', () => {
    expect(extractSlashQuery('/', 1)).toStrictEqual({ query: '', tokenEnd: 1 })
    expect(extractSlashQuery('/di', 3)).toStrictEqual({ query: 'di', tokenEnd: 3 })
    expect(extractSlashQuery('/diff body', 2)).toStrictEqual({ query: 'diff', tokenEnd: 5 })
  })

  it('closes once the caret leaves the first token', () => {
    expect(extractSlashQuery('/diff body', 6)).toBeNull()
    expect(extractSlashQuery('/diff body', 10)).toBeNull()
  })

  it('only treats the start of the prompt as a command', () => {
    expect(extractSlashQuery('hello /diff', 8)).toBeNull()
    expect(extractSlashQuery('\n/diff', 3)).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  const commands = [
    command('status', 'Show the current status'),
    command('diff', 'Review the working tree'),
    command('mcp:github:review', 'Review a pull request'),
    command('compact', 'Compact the conversation'),
  ]

  it('returns every command for an empty query', () => {
    expect(filterSlashCommands(commands, '')).toStrictEqual(commands)
  })

  it('ranks exact and prefix matches above description hits', () => {
    expect(filterSlashCommands(commands, 'diff').map((entry) => entry.name)).toStrictEqual(['diff'])
    expect(filterSlashCommands(commands, 'review').map((entry) => entry.name)).toStrictEqual([
      'mcp:github:review',
      'diff',
    ])
  })

  it('is case-insensitive and matches mcp prefixes', () => {
    expect(filterSlashCommands(commands, 'MCP').map((entry) => entry.name)).toStrictEqual([
      'mcp:github:review',
    ])
    expect(filterSlashCommands(commands, '/co').map((entry) => entry.name)).toStrictEqual([
      'compact',
    ])
  })

  it('returns nothing when no name or description matches', () => {
    expect(filterSlashCommands(commands, 'zzz')).toStrictEqual([])
  })
})

describe('applySlashCommand', () => {
  it('inserts a trailing space and leaves the caret ready for arguments', () => {
    expect(applySlashCommand('/di', 3, 'diff')).toStrictEqual({
      text: '/diff ',
      caret: 6,
    })
  })

  it('keeps existing body text and skips the extra space', () => {
    expect(applySlashCommand('/di hello', 3, 'diff')).toStrictEqual({
      text: '/diff hello',
      caret: 6,
    })
    expect(applySlashCommand('/di\nbody', 3, 'diff')).toStrictEqual({
      text: '/diff\nbody',
      caret: 6,
    })
  })

  it('normalizes leading slashes instead of doubling them', () => {
    expect(formatCommandName('/diff')).toBe('/diff')
    expect(applySlashCommand('/', 1, '/diff')).toStrictEqual({ text: '/diff ', caret: 6 })
  })
})
