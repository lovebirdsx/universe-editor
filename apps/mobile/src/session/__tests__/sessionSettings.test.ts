import type { MobileMcpSessionSettings } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { mcpStatusTone, resolveEnabledMcpNames, toggleMcpSelection } from '../sessionSettings.js'

const pool = [
  { name: 'a', transport: 'stdio' as const, defaultDisabled: false },
  { name: 'b', transport: 'stdio' as const, defaultDisabled: true },
  { name: 'c', transport: 'http' as const, defaultDisabled: false },
]

function settings(overrides: Partial<MobileMcpSessionSettings> = {}): MobileMcpSessionSettings {
  return {
    pool,
    selection: null,
    enabled: ['a', 'c'],
    live: [],
    ...overrides,
  }
}

describe('resolveEnabledMcpNames', () => {
  it('inherits every non-default-disabled entry in pool order', () => {
    expect(resolveEnabledMcpNames(pool, null)).toEqual(['a', 'c'])
  })

  it('intersects an explicit selection with the pool and may enable disabled entries', () => {
    expect(resolveEnabledMcpNames(pool, ['b', 'c', 'gone'])).toEqual(['b', 'c'])
    expect(resolveEnabledMcpNames(pool, [])).toEqual([])
  })
})

describe('toggleMcpSelection', () => {
  it('removes an enabled name and appends a disabled one', () => {
    expect(toggleMcpSelection(settings(), 'a')).toEqual(['c'])
    expect(toggleMcpSelection(settings(), 'b')).toEqual(['a', 'c', 'b'])
  })

  it('starts from the inherited enabled set when selection is null', () => {
    const inherited = settings({ selection: null, enabled: ['a'] })
    expect(toggleMcpSelection(inherited, 'c')).toEqual(['a', 'c'])
  })

  it('starts from the explicit selection when present', () => {
    const pinned = settings({ selection: ['b'], enabled: ['b'] })
    expect(toggleMcpSelection(pinned, 'a')).toEqual(['b', 'a'])
  })
})

describe('mcpStatusTone', () => {
  it('maps agent statuses to dot tones', () => {
    expect(mcpStatusTone('connected')).toBe('ok')
    expect(mcpStatusTone('failed')).toBe('error')
    expect(mcpStatusTone('needs-auth')).toBe('error')
    expect(mcpStatusTone('needs_auth')).toBe('error')
    expect(mcpStatusTone('pending')).toBe('pending')
    expect(mcpStatusTone('starting')).toBe('pending')
  })
})
