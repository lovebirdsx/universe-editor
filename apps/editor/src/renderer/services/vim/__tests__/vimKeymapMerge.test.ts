/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  `vim.keymap` parsing and merging: inheritance, unbinds, validation, defaults.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IVimKeymapEntry } from '@universe-editor/workbench-ui'
import { entryAppliesTo, mergeVimKeymap, parseUserKeymap } from '../vimKeymapMerge.js'

const BASE: readonly IVimKeymapEntry[] = [
  { id: 'list.focusDown', keys: ['j'], command: 'list.focusDown', surfaces: ['list', 'overlay'] },
  { id: 'list.delete', keys: ['d', 'd'], command: 'list.delete', surfaces: ['list'] },
  {
    id: 'chat.down',
    keys: ['j'],
    command: 'agent.down',
    surfaces: ['list'],
    when: 'acpChatFocused',
  },
  { id: 'leader.quickOpen', keys: ['<leader>', 'f'], command: 'workbench.action.quickOpen' },
  {
    id: 'editor.rename',
    keys: ['<leader>', 'm'],
    command: 'editor.action.rename',
    surfaces: ['editor'],
  },
]

const parse = (value: unknown) => parseUserKeymap(value, BASE, 'space')

function commands(
  kind: Parameters<typeof mergeVimKeymap>[0],
  value: unknown,
  surfaceEntries: readonly IVimKeymapEntry[] = [],
): string[] {
  const { items } = parse(value)
  return mergeVimKeymap(kind, BASE, surfaceEntries, items, 'space').map(
    (entry) => `${entry.keys.join(' ')}=${entry.command}`,
  )
}

describe('parseUserKeymap', () => {
  it('accepts nothing / null as an empty keymap', () => {
    expect(parse(undefined)).toEqual({ items: [], issues: [] })
    expect(parse(null)).toEqual({ items: [], issues: [] })
  })

  it('reports a non-array value', () => {
    const { items, issues } = parse({ id: 'x' })
    expect(items).toEqual([])
    expect(issues[0]).toContain('must be an array')
  })

  it('flags invalid key tokens with the reason and drops the entry', () => {
    const { items, issues } = parse([{ id: 'u', keys: ['ctrl+'], command: 'a.b' }])
    expect(items).toEqual([])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('invalid key token')
  })

  it('flags unknown surface kinds instead of silently widening the entry', () => {
    const { items, issues } = parse([{ id: 'u', keys: ['x'], command: 'a.b', surfaces: ['lists'] }])
    expect(items).toEqual([])
    expect(issues[0]).toContain('unknown surface "lists"')
  })

  it('keeps the valid kinds when only some are unknown', () => {
    const { items, issues } = parse([
      { id: 'u', keys: ['x'], command: 'a.b', surfaces: ['list', 'bogus'] },
    ])
    expect(items[0]?.surfaces).toEqual(['list'])
    expect(issues).toHaveLength(1)
  })

  it('requires keys and command for a new id', () => {
    const { items, issues } = parse([{ id: 'brand.new', keys: ['x'] }])
    expect(items).toEqual([])
    expect(issues[0]).toContain('needs both')
  })

  it('names anonymous entries user.<index>', () => {
    const { items } = parse([{ keys: ['x'], command: 'a.b' }])
    expect(items[0]?.id).toBe('user.0')
  })

  it('flags an unbind that matches nothing', () => {
    const { items, issues } = parse([{ keys: ['q', 'q'], command: '-' }])
    expect(items).toHaveLength(1)
    expect(issues[0]).toContain('matches no built-in mapping')
  })

  it('accepts an unbind by id, by keys, and by keys plus command', () => {
    const { issues } = parse([
      { id: 'list.delete', command: '-' },
      { keys: ['d', 'd'], command: '-' },
      { keys: ['d', 'd'], command: '-list.delete' },
    ])
    expect(issues).toEqual([])
  })

  it('needs an id or keys to unbind', () => {
    const { issues } = parse([{ command: '-list.delete' }])
    expect(issues[0]).toContain('needs an "id" or "keys"')
  })

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 3],
    ['an array', ['x']],
  ])('drops an entry that is %s', (_label, entry) => {
    const { items, issues } = parse([entry])
    expect(items).toEqual([])
    expect(issues).toEqual(['vim.keymap[0]: expected an object'])
  })

  it('drops an entry whose command is not a string', () => {
    const { items, issues } = parse([{ id: 'u', keys: ['x'], command: 3 }])
    expect(items).toEqual([])
    expect(issues[0]).toContain('"command" must be a string')
  })

  it('drops an entry with an empty key token, and one with no keys at all', () => {
    const empty = parse([{ id: 'u', keys: ['g', ''], command: 'a.b' }])
    expect(empty.items).toEqual([])
    expect(empty.issues[0]).toContain('non-empty strings')
    const none = parse([{ id: 'u', keys: [], command: 'a.b' }])
    expect(none.items).toEqual([])
    expect(none.issues[0]).toContain('non-empty array')
  })

  it('ignores a non-string when but keeps the entry', () => {
    const { items, issues } = parse([{ id: 'u', keys: ['x'], command: 'a.b', when: 3 }])
    expect(items).toHaveLength(1)
    expect(items[0]?.when).toBeUndefined()
    expect(issues[0]).toContain('"when" must be a string')
  })

  it('rejects an empty id string but still parses the rest', () => {
    const { items, issues } = parse([{ id: '', keys: ['x'], command: 'a.b' }])
    expect(items[0]?.id).toBe('user.0')
    expect(issues[0]).toContain('"id" must be a non-empty string')
  })

  it('flags unbinding the bare <leader>: only whole sequences can match', () => {
    const { issues } = parse([{ keys: ['<leader>'], command: '-' }])
    expect(issues[0]).toContain('matches no built-in mapping')
    expect(parse([{ keys: ['<leader>', 'f'], command: '-' }]).issues).toEqual([])
  })

  it('accepts an unbind of an entry the user adds in the same list', () => {
    const { issues } = parse([
      { id: 'mine', keys: ['Q'], command: 'a.b' },
      { id: 'mine', command: '-' },
      { keys: ['Q'], command: '-a.b' },
    ])
    expect(issues).toEqual([])
  })

  it('treats an override of a surface-declared id as an override, not a typo', () => {
    const known = [...BASE, { id: 'list.focusSearch', keys: ['/'], command: 'x.focusSearch' }]
    const { items, issues } = parseUserKeymap([{ id: 'list.focusSearch', keys: ['s'] }], known, 'x')
    expect(issues).toEqual([])
    expect(items).toHaveLength(1)
  })
})

describe('mergeVimKeymap', () => {
  it('lets an override by id inherit surfaces and when', () => {
    const { items } = parse([{ id: 'chat.down', keys: ['n'] }])
    const merged = mergeVimKeymap('list', BASE, [], items, 'space')
    const entry = merged.find((candidate) => candidate.id === 'chat.down')
    expect(entry).toMatchObject({
      keys: ['n'],
      command: 'agent.down',
      surfaces: ['list'],
      when: 'acpChatFocused',
    })
    // still scoped: the override must not leak onto other kinds
    expect(commands('menu', [{ id: 'chat.down', keys: ['n'] }])).not.toContain('n=agent.down')
  })

  it('lets an override replace surfaces explicitly', () => {
    expect(commands('menu', [{ id: 'list.delete', surfaces: ['menu'] }])).toContain(
      'd d=list.delete',
    )
  })

  it('applies a new entry without surfaces to every non-editor surface only', () => {
    const value = [{ id: 'u', keys: ['Q'], command: 'a.b' }]
    for (const kind of ['list', 'menu', 'overlay', 'tabs', 'terminal', 'reader'] as const) {
      expect(commands(kind, value)).toContain('Q=a.b')
    }
    expect(commands('editor', value)).not.toContain('Q=a.b')
  })

  it('applies a new <leader> entry without surfaces to the editor too', () => {
    expect(commands('editor', [{ id: 'u', keys: ['<leader>', 'Q'], command: 'a.b' }])).toContain(
      'space Q=a.b',
    )
  })

  it('replaces <leader> with the configured leader', () => {
    const { items } = parse([])
    const merged = mergeVimKeymap('list', BASE, [], items, ',')
    expect(merged.find((entry) => entry.id === 'leader.quickOpen')?.keys).toEqual([',', 'f'])
  })

  it('removes an unbind by id, by keys, and only the named command', () => {
    expect(commands('list', [{ id: 'list.delete', command: '-' }])).not.toContain('d d=list.delete')
    expect(commands('list', [{ keys: ['d', 'd'], command: '-' }])).not.toContain('d d=list.delete')
    expect(commands('list', [{ keys: ['d', 'd'], command: '-other.cmd' }])).toContain(
      'd d=list.delete',
    )
  })

  it('limits an unbind to the listed surfaces', () => {
    const value = [{ id: 'list.focusDown', command: '-', surfaces: ['overlay'] }]
    expect(commands('overlay', value)).not.toContain('j=list.focusDown')
    expect(commands('list', value)).toContain('j=list.focusDown')
  })

  it('puts surface-declared entries first, tagged, and ignoring surfaces', () => {
    const surfaceEntries: readonly IVimKeymapEntry[] = [
      { id: 'list.focusSearch', keys: ['/'], command: 'x.focusSearch', surfaces: ['menu'] },
    ]
    const { items } = parse([])
    const merged = mergeVimKeymap('list', BASE, surfaceEntries, items, 'space')
    expect(merged[0]).toMatchObject({ id: 'list.focusSearch', scope: 'surface' })
    expect(merged[0]?.surfaces).toBeUndefined()
  })

  it('lets the user override or unbind a surface-declared entry by id', () => {
    const surfaceEntries: readonly IVimKeymapEntry[] = [
      { id: 'list.focusSearch', keys: ['/'], command: 'x.focusSearch' },
    ]
    const known = [...BASE, ...surfaceEntries]
    const rebound = parseUserKeymap([{ id: 'list.focusSearch', keys: ['s'] }], known, 'space')
    expect(rebound.issues).toEqual([])
    expect(mergeVimKeymap('list', BASE, surfaceEntries, rebound.items, 'space')[0]?.keys).toEqual([
      's',
    ])
    const removed = parseUserKeymap([{ id: 'list.focusSearch', command: '-' }], known, 'space')
    expect(
      mergeVimKeymap('list', BASE, surfaceEntries, removed.items, 'space').some(
        (entry) => entry.id === 'list.focusSearch',
      ),
    ).toBe(false)
  })
})

describe('mergeVimKeymap with surface-declared ids', () => {
  const SURFACE: readonly IVimKeymapEntry[] = [
    { id: 'list.focusSearch', keys: ['/'], command: 'x.focusSearch', surfaces: ['menu'] },
  ]
  const KNOWN = [...BASE, ...SURFACE]
  const merge = (
    kind: Parameters<typeof mergeVimKeymap>[0],
    value: unknown,
    active: readonly IVimKeymapEntry[],
  ) => {
    const { items } = parseUserKeymap(value, KNOWN, 'space')
    return mergeVimKeymap(kind, BASE, active, items, 'space', SURFACE)
  }

  it('does not turn a full override of a surface id into a global entry', () => {
    const value = [{ id: 'list.focusSearch', keys: ['s'], command: 'x.other' }]
    for (const kind of ['list', 'menu', 'overlay', 'tabs', 'reader'] as const) {
      expect(merge(kind, value, []).some((entry) => entry.id === 'list.focusSearch')).toBe(false)
    }
  })

  it('applies the override with scope surface while that surface is active', () => {
    const value = [{ id: 'list.focusSearch', keys: ['s'], command: 'x.other', surfaces: ['menu'] }]
    const entry = merge('list', value, SURFACE).find(
      (candidate) => candidate.id === 'list.focusSearch',
    )
    expect(entry).toMatchObject({ keys: ['s'], command: 'x.other', scope: 'surface' })
  })

  it('unbinds a surface-declared entry by id and by keys', () => {
    for (const unbind of [
      { id: 'list.focusSearch', command: '-' },
      { keys: ['/'], command: '-x.focusSearch' },
    ]) {
      expect(
        merge('list', [unbind], SURFACE).some((entry) => entry.id === 'list.focusSearch'),
      ).toBe(false)
    }
  })

  it('inherits when and args of the declared entry on a partial override', () => {
    const declared: readonly IVimKeymapEntry[] = [
      { id: 'g.search', keys: ['/'], command: 'g.focus', when: 'graphFocused', args: { a: 1 } },
    ]
    const { items } = parseUserKeymap([{ id: 'g.search', keys: ['s'] }], declared, 'space')
    const [entry] = mergeVimKeymap('list', [], declared, items, 'space', declared)
    expect(entry).toMatchObject({
      keys: ['s'],
      command: 'g.focus',
      when: 'graphFocused',
      args: { a: 1 },
      scope: 'surface',
    })
  })

  it('lets the user replace args and when explicitly', () => {
    const declared: readonly IVimKeymapEntry[] = [
      { id: 'g.search', keys: ['/'], command: 'g.focus', when: 'graphFocused', args: { a: 1 } },
    ]
    const { items } = parseUserKeymap(
      [{ id: 'g.search', when: 'other', args: { b: 2 } }],
      declared,
      'space',
    )
    const [entry] = mergeVimKeymap('list', [], declared, items, 'space', declared)
    expect(entry).toMatchObject({ when: 'other', args: { b: 2 }, keys: ['/'] })
  })
})

describe('mergeVimKeymap user-added entries', () => {
  it('lets a later unbind remove an entry the user added', () => {
    expect(
      commands('list', [
        { id: 'mine', keys: ['Q'], command: 'a.b' },
        { id: 'mine', command: '-' },
      ]),
    ).not.toContain('Q=a.b')
    expect(
      commands('list', [
        { id: 'mine', keys: ['Q'], command: 'a.b' },
        { keys: ['Q'], command: '-a.b' },
      ]),
    ).not.toContain('Q=a.b')
  })

  it('carries when and args of a new entry', () => {
    const { items } = parse([{ id: 'mine', keys: ['Q'], command: 'a.b', when: 'x', args: [1] }])
    const entry = mergeVimKeymap('list', BASE, [], items, 'space').find((e) => e.id === 'mine')
    expect(entry).toMatchObject({ when: 'x', args: [1] })
  })
})

describe('entryAppliesTo', () => {
  it('treats scope surface as always applicable', () => {
    expect(
      entryAppliesTo({ id: 'a', keys: ['x'], command: 'c', scope: 'surface' }, 'editor', 'space'),
    ).toBe(true)
  })

  it('lets an explicit editor entry reach the editor only when it starts with a modifier chord', () => {
    const entry = (keys: string[]) => ({
      id: 'a',
      keys,
      command: 'c',
      surfaces: ['editor' as const],
    })
    expect(entryAppliesTo(entry(['ctrl+o']), 'editor', 'space')).toBe(true)
    expect(entryAppliesTo(entry(['alt+x', 'y']), 'editor', 'space')).toBe(true)
    expect(entryAppliesTo(entry(['<leader>', 'x']), 'editor', 'space')).toBe(true)
    // Bare keys are the editor core's; such an entry could never be dispatched there.
    expect(entryAppliesTo(entry(['Q']), 'editor', 'space')).toBe(false)
    expect(entryAppliesTo(entry(['Q']), 'list', 'space')).toBe(false)
  })
})
