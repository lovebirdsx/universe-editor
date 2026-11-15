import type { MobileAvailableCommand } from '@universe-editor/mobile-protocol'
import { describe, expect, it, vi } from 'vitest'
import { filterSlashCommands } from '../slashCommands.js'
import {
  MAX_SLASH_USAGE_ENTRIES,
  SLASH_USAGE_STORAGE_KEY,
  orderSlashCommandsByUsage,
  parseSlashUsage,
  readSlashUsage,
  recordSlashUsage,
  writeSlashUsage,
} from '../slashUsage.js'

function command(name: string, description = ''): MobileAvailableCommand {
  return { name, description }
}

describe('parseSlashUsage', () => {
  it('falls back to an empty list for missing or malformed values', () => {
    expect(parseSlashUsage(undefined)).toStrictEqual([])
    expect(parseSlashUsage('')).toStrictEqual([])
    expect(parseSlashUsage('not json')).toStrictEqual([])
    expect(parseSlashUsage('null')).toStrictEqual([])
    expect(parseSlashUsage('{}')).toStrictEqual([])
  })

  it('skips invalid entries and normalizes names', () => {
    expect(parseSlashUsage('["compact", 3, null, "/diff", "COMPACT", "  review  "]')).toStrictEqual(
      ['compact', 'diff', 'review'],
    )
  })

  it('keeps skill names that start with $', () => {
    expect(parseSlashUsage('["$build"]')).toStrictEqual(['$build'])
  })

  it('caps the list at the storage limit', () => {
    const names = Array.from({ length: MAX_SLASH_USAGE_ENTRIES + 10 }, (_, index) => `cmd${index}`)
    expect(parseSlashUsage(JSON.stringify(names))).toStrictEqual(
      names.slice(0, MAX_SLASH_USAGE_ENTRIES),
    )
  })
})

describe('slash usage storage', () => {
  it('reads an empty list when nothing was stored', () => {
    expect(readSlashUsage()).toStrictEqual([])
  })

  it('round-trips the most-recent-first order', () => {
    writeSlashUsage(['compact', 'diff'])
    expect(readSlashUsage()).toStrictEqual(['compact', 'diff'])
  })

  it('keeps the default when storage reads fail', () => {
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    try {
      expect(readSlashUsage()).toStrictEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('does not throw when storage writes fail', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    try {
      expect(() => writeSlashUsage(['compact'])).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('recordSlashUsage', () => {
  it('appends the first use', () => {
    expect(recordSlashUsage([], 'compact')).toStrictEqual(['compact'])
  })

  it('moves an existing use to the front without duplicating it', () => {
    expect(recordSlashUsage(['diff', 'compact'], 'compact')).toStrictEqual(['compact', 'diff'])
  })

  it('normalizes a leading slash', () => {
    expect(recordSlashUsage(['compact'], '/diff')).toStrictEqual(['diff', 'compact'])
  })

  it('dedupes names case-insensitively and keeps the newest spelling', () => {
    expect(recordSlashUsage(['compact'], 'COMPACT')).toStrictEqual(['COMPACT'])
  })

  it('ignores an empty name', () => {
    const usage = ['compact']
    expect(recordSlashUsage(usage, ' // ')).toBe(usage)
  })

  it('drops the oldest entry once the limit is reached', () => {
    const usage = Array.from({ length: MAX_SLASH_USAGE_ENTRIES }, (_, index) => `cmd${index}`)
    const next = recordSlashUsage(usage, 'new')
    expect(next).toHaveLength(MAX_SLASH_USAGE_ENTRIES)
    expect(next[0]).toBe('new')
    expect(next).not.toContain(`cmd${MAX_SLASH_USAGE_ENTRIES - 1}`)
  })
})

describe('orderSlashCommandsByUsage', () => {
  const commands = [command('review'), command('rewind'), command('status')]

  it('returns the original array when nothing has been used', () => {
    expect(orderSlashCommandsByUsage(commands, [])).toBe(commands)
  })

  it('returns the original array when no current command was used', () => {
    expect(orderSlashCommandsByUsage(commands, ['offline'])).toBe(commands)
  })

  it('puts recently used commands first and keeps the agent order for the rest', () => {
    expect(
      orderSlashCommandsByUsage(commands, ['status']).map((entry) => entry.name),
    ).toStrictEqual(['status', 'review', 'rewind'])
    expect(
      orderSlashCommandsByUsage(commands, ['rewind', 'review']).map((entry) => entry.name),
    ).toStrictEqual(['rewind', 'review', 'status'])
  })

  it('matches names case-insensitively and after slash normalization', () => {
    expect(
      orderSlashCommandsByUsage(commands, ['/REWIND']).map((entry) => entry.name),
    ).toStrictEqual(['rewind', 'review', 'status'])
  })

  it('matches skill names that start with $', () => {
    const skills = [command('diff'), command('$build')]
    expect(orderSlashCommandsByUsage(skills, ['$build']).map((entry) => entry.name)).toStrictEqual([
      '$build',
      'diff',
    ])
  })

  it('feeds the empty-query list in recency order', () => {
    expect(
      filterSlashCommands(orderSlashCommandsByUsage(commands, ['status']), '').map(
        (entry) => entry.name,
      ),
    ).toStrictEqual(['status', 'review', 'rewind'])
  })

  it('breaks relevance ties by recency without outranking stronger matches', () => {
    expect(
      filterSlashCommands(orderSlashCommandsByUsage(commands, ['rewind']), 're').map(
        (entry) => entry.name,
      ),
    ).toStrictEqual(['rewind', 'review'])

    const mixed = [command('status', 'diff helper'), command('diff')]
    expect(
      filterSlashCommands(orderSlashCommandsByUsage(mixed, ['status']), 'diff').map(
        (entry) => entry.name,
      ),
    ).toStrictEqual(['diff', 'status'])
  })
})

describe('SLASH_USAGE_STORAGE_KEY', () => {
  it('stays namespaced to this device', () => {
    expect(SLASH_USAGE_STORAGE_KEY).toBe('universe.mobile.slashUsage')
  })
})
