import { describe, expect, it } from 'vitest'
import type { IVimKeymapEntry } from '@universe-editor/workbench-ui'
import { computeWhichKeyItems } from '../vimWhichKeyItems.js'

const entries: readonly IVimKeymapEntry[] = [
  { id: 'e', keys: ['space', 'e'], command: 'workbench.view.explorer' },
  { id: 'wh', keys: ['space', 'w', 'h'], command: 'workbench.action.focusLeftGroup' },
  { id: 'wl', keys: ['space', 'w', 'l'], command: 'workbench.action.focusRightGroup' },
  { id: 'gg', keys: ['g', 'g'], command: 'list.focusFirst' },
  { id: 'only', keys: ['space', 'x'], command: 'when.gated', when: 'someKey' },
]
const title = (command: string) => `T:${command}`
const always = () => true

describe('computeWhichKeyItems', () => {
  it('lists leaves with titles and groups with a count', () => {
    const items = computeWhichKeyItems(entries, ['space'], always, title)
    expect(items.map((item) => [item.key, item.isGroup])).toEqual([
      ['e', false],
      ['w', true],
      ['x', false],
    ])
    expect(items[0]?.title).toBe('T:workbench.view.explorer')
  })

  it('descends into a deeper prefix and ignores other prefixes', () => {
    const items = computeWhichKeyItems(entries, ['space', 'w'], always, title)
    expect(items.map((item) => item.key)).toEqual(['h', 'l'])
  })

  it('drops entries whose when fails', () => {
    const items = computeWhichKeyItems(
      entries,
      ['space'],
      (entry) => entry.when === undefined,
      title,
    )
    expect(items.map((item) => item.key)).toEqual(['e', 'w'])
  })

  it('returns nothing for a prefix with no continuation', () => {
    expect(computeWhichKeyItems(entries, ['q'], always, title)).toEqual([])
  })

  it('prefers the surface-declared leaf over a default one on the same key', () => {
    const items = computeWhichKeyItems(
      [
        { id: 'a', keys: ['space', 'e'], command: 'default.cmd' },
        { id: 'b', keys: ['space', 'e'], command: 'surface.cmd', scope: 'surface' },
      ],
      ['space'],
      always,
      title,
    )
    expect(items).toEqual([{ key: 'e', title: 'T:surface.cmd', isGroup: false }])
  })

  it('titles a group with the number of continuations under it', () => {
    const items = computeWhichKeyItems(entries, ['space'], always, title)
    expect(items.find((item) => item.key === 'w')).toEqual({
      key: 'w',
      title: '+2',
      isGroup: true,
    })
  })

  it('shows a key that is both a command and a prefix with its command and the +N', () => {
    const items = computeWhichKeyItems(
      [
        { id: 'z', keys: ['space', 'z'], command: 'fold.toggle' },
        { id: 'za', keys: ['space', 'z', 'a'], command: 'fold.all' },
        { id: 'zb', keys: ['space', 'z', 'b'], command: 'fold.none' },
      ],
      ['space'],
      always,
      title,
    )
    expect(items).toEqual([{ key: 'z', title: 'T:fold.toggle (+2)', isGroup: true }])
  })

  it('counts only continuations whose when passes', () => {
    const items = computeWhichKeyItems(
      [
        { id: 'a', keys: ['g', 'a'], command: 'x.a' },
        { id: 'b', keys: ['g', 'b'], command: 'x.b', when: 'no' },
      ],
      [],
      (entry) => entry.when === undefined,
      title,
    )
    expect(items).toEqual([{ key: 'g', title: '+1', isGroup: true }])
  })
})
