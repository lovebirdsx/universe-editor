/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type {
  IKeybindingRow,
  IKeybindingsEditorModel,
  KeybindingSource,
} from '../keybindingsEditorModel.js'
import {
  countKeybindingConflicts,
  fetchKeybindings,
  parseKeybindingsQuery,
} from '../keybindingsSearchModel.js'

function makeRow(overrides: Partial<IKeybindingRow> & { command: string }): IKeybindingRow {
  const source: KeybindingSource = overrides.source ?? { kind: 'system' }
  const sourceKind = source.kind
  return {
    id: `${overrides.command}|${overrides.keybinding ?? ''}|${overrides.when ?? ''}|${sourceKind}`,
    commandLabel: overrides.command,
    commandDefaultLabel: undefined,
    keybinding: undefined,
    chords: [],
    when: undefined,
    source,
    isDefault: sourceKind !== 'user',
    precedence: 0,
    ...overrides,
  }
}

function makeModel(
  rows: readonly IKeybindingRow[],
  byPrecedence?: readonly IKeybindingRow[],
): IKeybindingsEditorModel {
  const byKey = new Map<string, IKeybindingRow[]>()
  for (const row of rows) {
    if (row.keybinding === undefined) continue
    const list = byKey.get(row.keybinding)
    if (list) list.push(row)
    else byKey.set(row.keybinding, [row])
  }
  return { alphabetical: rows, byPrecedence: byPrecedence ?? rows, byKey }
}

function fetchText(model: IKeybindingsEditorModel, raw: string, sortByPrecedence = false) {
  return fetchKeybindings(model, parseKeybindingsQuery(raw), sortByPrecedence)
}

describe('parseKeybindingsQuery', () => {
  it('parses plain text', () => {
    expect(parseKeybindingsQuery('git pull')).toEqual({
      commandId: undefined,
      when: undefined,
      source: undefined,
      extensionQuery: undefined,
      text: 'git pull',
      completeMatch: false,
    })
  })

  it('parses @command with an optional +when suffix', () => {
    expect(parseKeybindingsQuery('@command:workbench.action.quickOpen')).toMatchObject({
      commandId: 'workbench.action.quickOpen',
      when: undefined,
      text: '',
    })
    expect(parseKeybindingsQuery('@command:foo +when:editorFocus')).toMatchObject({
      commandId: 'foo',
      when: 'editorFocus',
      text: '',
    })
    expect(parseKeybindingsQuery('@command:foo +when:a && b')).toMatchObject({
      commandId: 'foo',
      when: 'a && b',
    })
  })

  it('parses @source with default aliasing system', () => {
    expect(parseKeybindingsQuery('@source:user').source).toBe('user')
    expect(parseKeybindingsQuery('@source:default').source).toBe('system')
    expect(parseKeybindingsQuery('@source:SYSTEM').source).toBe('system')
    expect(parseKeybindingsQuery('@source:extension').source).toBe('extension')
    const withText = parseKeybindingsQuery('@source:user extra words')
    expect(withText.source).toBe('user')
    expect(withText.text).toBe('extra words')
  })

  it('parses @ext by id or quoted display name', () => {
    expect(parseKeybindingsQuery('@ext:pub.cool')).toMatchObject({
      extensionQuery: 'pub.cool',
      text: '',
    })
    expect(parseKeybindingsQuery('@ext:"Cool Ext"')).toMatchObject({
      extensionQuery: 'Cool Ext',
      text: '',
    })
  })

  it('rewrites @keybinding into a quoted exact-match text', () => {
    expect(parseKeybindingsQuery('@keybinding:ctrl+k')).toMatchObject({
      text: 'ctrl+k',
      completeMatch: true,
    })
    expect(parseKeybindingsQuery('@keybinding:"ctrl+k ctrl+s"')).toMatchObject({
      text: 'ctrl+k ctrl+s',
      completeMatch: true,
    })
  })

  it('treats surrounding quotes as completeMatch and strips them', () => {
    expect(parseKeybindingsQuery('"ctrl+shift+p"')).toMatchObject({
      text: 'ctrl+shift+p',
      completeMatch: true,
    })
    expect(parseKeybindingsQuery('"partial quote')).toMatchObject({
      text: 'partial quote',
      completeMatch: false,
    })
  })
})

describe('fetchKeybindings filters', () => {
  const userRow = makeRow({ command: 'cmd.user', commandLabel: 'Alpha', source: { kind: 'user' } })
  const systemRow = makeRow({ command: 'cmd.system', commandLabel: 'Alpha' })
  const extensionRow = makeRow({
    command: 'cmd.ext',
    commandLabel: 'Alpha',
    source: { kind: 'extension', extensionId: 'pub.cool', extensionLabel: 'Cool Ext' },
  })
  const otherExtensionRow = makeRow({
    command: 'cmd.ext2',
    commandLabel: 'Beta',
    source: { kind: 'extension', extensionId: 'pub.other', extensionLabel: 'Other' },
  })
  const model = makeModel([userRow, systemRow, extensionRow, otherExtensionRow])

  it('filters by @source with default equivalent to system', () => {
    expect(fetchText(model, '@source:user').map((m) => m.row)).toEqual([userRow])
    expect(fetchText(model, '@source:default').map((m) => m.row)).toEqual([systemRow])
    expect(fetchText(model, '@source:extension').map((m) => m.row)).toEqual([
      extensionRow,
      otherExtensionRow,
    ])
  })

  it('combines @source with free text', () => {
    expect(fetchText(model, '@source:user alpha').map((m) => m.row)).toEqual([userRow])
  })

  it('filters by @ext id or display name, case-insensitively', () => {
    expect(fetchText(model, '@ext:pub.cool').map((m) => m.row)).toEqual([extensionRow])
    expect(fetchText(model, '@ext:"cool ext"').map((m) => m.row)).toEqual([extensionRow])
    expect(fetchText(model, '@ext:PUB.OTHER').map((m) => m.row)).toEqual([otherExtensionRow])
  })

  it('filters by @command and returns rows with empty matches', () => {
    const a1 = makeRow({ command: 'cmd.a', keybinding: 'ctrl+a' })
    const a2 = makeRow({ command: 'cmd.a', keybinding: 'ctrl+b', when: 'editorFocus' })
    const b = makeRow({ command: 'cmd.b', keybinding: 'ctrl+c' })
    const commandModel = makeModel([a1, a2, b])
    expect(fetchText(commandModel, '@command:cmd.a').map((m) => m.row)).toEqual([a1, a2])
    expect(fetchText(commandModel, '@command:cmd.a')[0]!.matches).toEqual({})
    expect(fetchText(commandModel, '@command:cmd.missing')).toEqual([])
  })

  it('@command +when narrows to rows with the same when clause', () => {
    const a1 = makeRow({ command: 'cmd.a', keybinding: 'ctrl+a' })
    const a2 = makeRow({ command: 'cmd.a', keybinding: 'ctrl+b', when: 'editorFocus' })
    const commandModel = makeModel([a1, a2])
    expect(fetchText(commandModel, '@command:cmd.a +when:editorFocus').map((m) => m.row)).toEqual([
      a2,
    ])
  })

  it('@command +when synthesizes a virtual unbound row when no row carries that when', () => {
    const a1 = makeRow({ command: 'cmd.a', commandLabel: 'Cmd A', keybinding: 'ctrl+a' })
    const commandModel = makeModel([a1])
    const result = fetchText(commandModel, '@command:cmd.a +when:terminalFocus')
    expect(result).toHaveLength(1)
    const virtual = result[0]!.row
    expect(virtual).toMatchObject({
      command: 'cmd.a',
      commandLabel: 'Cmd A',
      keybinding: undefined,
      chords: [],
      when: 'terminalFocus',
      source: { kind: 'system' },
      isDefault: true,
    })
    expect(virtual.id).toContain('virtual')
  })
})

describe('fetchKeybindings text matching', () => {
  it('requires every word to hit at least one field (AND across words)', () => {
    const pull = makeRow({ command: 'git.pull', commandLabel: 'Git: Pull' })
    const commit = makeRow({ command: 'git.commit', commandLabel: 'Git: Commit' })
    const model = makeModel([pull, commit])
    const result = fetchText(model, 'git pull')
    expect(result.map((m) => m.row)).toEqual([pull])
    expect(result[0]!.matches.commandLabel).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 9 },
    ])
  })

  it('lets words distribute across fields', () => {
    const row = makeRow({ command: 'workbench.files.save', commandLabel: 'File: Save' })
    const result = fetchText(makeModel([row]), 'file workbench')
    expect(result.map((m) => m.row)).toEqual([row])
    expect(result[0]!.matches.commandId).toEqual([
      { start: 0, end: 9 },
      { start: 10, end: 14 },
    ])
    expect(result[0]!.matches.commandLabel).toEqual([{ start: 0, end: 4 }])
  })

  it('matches camelCase anchors in the command id', () => {
    const row = makeRow({ command: 'editor.action.goToDeclaration', commandLabel: 'Zzz' })
    const result = fetchText(makeModel([row]), 'gtd')
    expect(result.map((m) => m.row)).toEqual([row])
    expect(result[0]!.matches.commandId).toEqual([
      { start: 14, end: 15 },
      { start: 16, end: 17 },
      { start: 18, end: 19 },
    ])
  })

  it('matches a contiguous substring at a word start in the command id', () => {
    const row = makeRow({ command: 'workbench.action.quickOpen', commandLabel: 'Zzz' })
    const result = fetchText(makeModel([row]), 'quickopen')
    expect(result[0]!.matches.commandId).toEqual([{ start: 17, end: 26 }])
  })

  it('matches the when clause and the default label', () => {
    const row = makeRow({
      command: 'cmd.x',
      commandLabel: 'Zzz',
      commandDefaultLabel: 'File: Save As',
      when: 'editorFocus',
    })
    const byWhen = fetchText(makeModel([row]), 'editorfocus')
    expect(byWhen[0]!.matches.when).toEqual([{ start: 0, end: 11 }])
    const byDefaultLabel = fetchText(makeModel([row]), 'save')
    expect(byDefaultLabel[0]!.matches.commandDefaultLabel).toEqual([{ start: 6, end: 10 }])
  })

  it('matches the source label of user and system rows', () => {
    const userRow = makeRow({ command: 'cmd.save', commandLabel: 'Save', source: { kind: 'user' } })
    const systemRow = makeRow({ command: 'cmd.load', commandLabel: 'Load' })
    const model = makeModel([userRow, systemRow])
    expect(fetchText(model, 'user')[0]!.matches.source).toEqual([{ start: 0, end: 4 }])
    expect(fetchText(model, 'system')[0]!.matches.source).toEqual([{ start: 0, end: 6 }])
  })

  it('matches the extension label of extension rows', () => {
    const row = makeRow({
      command: 'cmd.ext',
      commandLabel: 'Zzz',
      source: { kind: 'extension', extensionId: 'pub.cool', extensionLabel: 'Cool Ext' },
    })
    const result = fetchText(makeModel([row]), 'cool')
    expect(result[0]!.matches.extensionLabel).toEqual([{ start: 0, end: 4 }])
  })
})

describe('fetchKeybindings keybinding matching', () => {
  it('matches words against the first chord of a chorded keybinding', () => {
    const row = makeRow({ command: 'cmd.chord', keybinding: 'ctrl+k ctrl+s' })
    const result = fetchText(makeModel([row]), 'ctrl+k')
    expect(result.map((m) => m.row)).toEqual([row])
    expect(result[0]!.matches.keybinding).toEqual({
      firstPart: { ctrlKey: true, keyCode: true },
      chordPart: {},
    })
  })

  it('distributes words across both chords', () => {
    const row = makeRow({ command: 'cmd.chord', keybinding: 'ctrl+k ctrl+s' })
    const result = fetchText(makeModel([row]), 'ctrl k s')
    expect(result[0]!.matches.keybinding).toEqual({
      firstPart: { ctrlKey: true, keyCode: true },
      chordPart: { keyCode: true },
    })
  })

  it('recognizes modifier aliases (option → alt, cmd → meta)', () => {
    const altRow = makeRow({ command: 'cmd.alt', keybinding: 'alt+x' })
    const metaRow = makeRow({ command: 'cmd.meta', keybinding: 'meta+p' })
    expect(fetchText(makeModel([altRow]), 'option x')[0]!.matches.keybinding).toEqual({
      firstPart: { altKey: true, keyCode: true },
      chordPart: {},
    })
    expect(fetchText(makeModel([metaRow]), 'cmd p')[0]!.matches.keybinding).toEqual({
      firstPart: { metaKey: true, keyCode: true },
      chordPart: {},
    })
  })

  it('excludes rows whose keybinding does not cover every word', () => {
    const row = makeRow({ command: 'cmd.k', commandLabel: 'Zzz', keybinding: 'ctrl+k' })
    expect(fetchText(makeModel([row]), 'ctrl alt')).toEqual([])
  })

  it('quoted full keybinding marks every part complete', () => {
    const row = makeRow({ command: 'cmd.chord', keybinding: 'ctrl+k ctrl+s' })
    const result = fetchText(makeModel([row]), '"ctrl+k ctrl+s"')
    expect(result[0]!.matches.keybinding).toEqual({
      firstPart: { ctrlKey: true, keyCode: true },
      chordPart: { ctrlKey: true, keyCode: true },
    })
  })

  it('quoted queries skip text fields and reject incomplete modifier coverage', () => {
    const row = makeRow({ command: 'cmd.ctrl.k', commandLabel: 'Ctrl K', keybinding: 'ctrl+k' })
    // 'k' alone is not a complete match: the pressed ctrl modifier is unmatched.
    expect(fetchText(makeModel([row]), '"k"')).toEqual([])
    // 'ctrl' would hit the command label as free text, but quoted queries only
    // match the keybinding — and a modifier-only word set is not complete.
    expect(fetchText(makeModel([row]), '"ctrl"')).toEqual([])
    // The full word set is a complete match even without the '+' separators.
    expect(fetchText(makeModel([row]), '"ctrl k"')[0]!.matches.keybinding).toEqual({
      firstPart: { ctrlKey: true, keyCode: true },
      chordPart: {},
    })
  })

  it('keeps only the exact row for a quoted multi-modifier keybinding', () => {
    const exact = makeRow({ command: 'cmd.exact', keybinding: 'ctrl+shift+p' })
    const subset = makeRow({ command: 'cmd.subset', keybinding: 'ctrl+p' })
    const other = makeRow({ command: 'cmd.other', keybinding: 'shift+p' })
    const result = fetchText(makeModel([exact, subset, other]), '"ctrl+shift+p"')
    expect(result.map((m) => m.row)).toEqual([exact])
  })
})

describe('fetchKeybindings source arrays', () => {
  it('returns every row with empty matches for an empty query', () => {
    const a = makeRow({ command: 'cmd.a', keybinding: 'ctrl+a' })
    const b = makeRow({ command: 'cmd.b' })
    const model = makeModel([a, b])
    const result = fetchText(model, '')
    expect(result.map((m) => m.row)).toEqual([a, b])
    expect(result.every((m) => Object.keys(m.matches).length === 0)).toBe(true)
    expect(fetchText(model, '   ').map((m) => m.row)).toEqual([a, b])
  })

  it('switches between alphabetical and precedence order', () => {
    const rowA = makeRow({ command: 'cmd.a', keybinding: 'ctrl+a' })
    const rowB = makeRow({ command: 'cmd.b', keybinding: 'ctrl+b' })
    const model = makeModel([rowB, rowA], [rowA, rowB])
    expect(fetchText(model, '', false).map((m) => m.row)).toEqual([rowB, rowA])
    expect(fetchText(model, '', true).map((m) => m.row)).toEqual([rowA, rowB])
  })
})

describe('countKeybindingConflicts', () => {
  it('counts rows sharing the normalized key', () => {
    const a = makeRow({ command: 'cmd.a', keybinding: 'ctrl+shift+x' })
    const b = makeRow({ command: 'cmd.b', keybinding: 'ctrl+shift+x' })
    const c = makeRow({ command: 'cmd.c', keybinding: 'ctrl+y' })
    const model = makeModel([a, b, c])
    expect(countKeybindingConflicts(model, 'Ctrl+Shift+X')).toBe(2)
    expect(countKeybindingConflicts(model, 'shift+ctrl+x')).toBe(2)
    expect(countKeybindingConflicts(model, 'ctrl+y')).toBe(1)
    expect(countKeybindingConflicts(model, 'ctrl+shift+z')).toBe(0)
  })
})
