/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { KeybindingWeight, type ICommandMetadata } from '@universe-editor/platform'
import type { DecodedKeybinding } from '../../../workbench/editor/monaco/monacoKeybindingDecoder.js'
import {
  resolveKeybindingEntries,
  type IKeybindingModelDeps,
  type IKeybindingRow,
} from '../keybindingsEditorModel.js'

function makeDeps(overrides: Partial<IKeybindingModelDeps> = {}): IKeybindingModelDeps {
  return {
    commands: new Map<string, ICommandMetadata | undefined>(),
    registryEntries: [],
    monacoDefaults: new Map<string, DecodedKeybinding>(),
    userEntries: [],
    extensionIdOf: () => undefined,
    extensionLabelOf: () => undefined,
    ...overrides,
  }
}

function rowsByCommand(
  rows: readonly IKeybindingRow[],
  command: string,
): readonly IKeybindingRow[] {
  return rows.filter((r) => r.command === command)
}

describe('resolveKeybindingEntries', () => {
  it('orders rows by precedence: higher weight first, newest first within one weight', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [
          { key: 'ctrl+a', command: 'c.old', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+b', command: 'c.new', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+c', command: 'c.heavy', weight: KeybindingWeight.ExternalExtension },
        ],
      }),
    )
    expect(model.byPrecedence.map((r) => r.command)).toEqual(['c.heavy', 'c.new', 'c.old'])
    expect(model.byPrecedence.map((r) => r.precedence)).toEqual([0, 1, 2])
  })

  it('suppresses a default binding hit by a negation and never rows the negation itself', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [
          { key: 'ctrl+s', command: 'save', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+s', command: 'save', isNegated: true },
        ],
      }),
    )
    expect(model.byPrecedence).toEqual([])
    expect(model.byKey.size).toBe(0)
  })

  it('suppresses only the negated key, leaving sibling bindings of the same command live', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [
          { key: 'ctrl+s', command: 'save', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+alt+s', command: 'save', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+s', command: 'save', isNegated: true },
        ],
      }),
    )
    // Registry key space sorts modifiers alphabetically: ctrl+alt → alt+ctrl.
    expect(model.byPrecedence.map((r) => r.keybinding)).toEqual(['alt+ctrl+s'])
  })

  it('produces the user rebind row from userEntries and skips User-weight registry duplicates', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [
          { key: 'ctrl+s', command: 'save', weight: KeybindingWeight.WorkbenchContrib },
          // Mirrors UserKeybindingsService: the rebind is also registered into
          // the registry at User weight, plus a negation of the original key.
          { key: 'ctrl+s', command: 'save', isNegated: true },
          { key: 'ctrl+alt+s', command: 'save', weight: KeybindingWeight.User },
        ],
        userEntries: [
          { command: 'save', key: 'ctrl+alt+s' },
          { command: 'save', key: 'ctrl+s', isRemoval: true },
        ],
      }),
    )
    const rows = rowsByCommand(model.byPrecedence, 'save')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      keybinding: 'alt+ctrl+s',
      isDefault: false,
      source: { kind: 'user' },
    })
  })

  it('treats a pure disable (key=null) as no row: the command falls into unbound', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        commands: new Map([['save', { description: 'Save' }]]),
        registryEntries: [
          { key: 'ctrl+s', command: 'save', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+s', command: 'save', isNegated: true },
        ],
        userEntries: [{ command: 'save', key: null, isRemoval: true }],
      }),
    )
    const rows = rowsByCommand(model.byPrecedence, 'save')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ keybinding: undefined, source: { kind: 'system' } })
  })

  it('collects unbound commands, skipping `_`-prefixed and metadata-less commands', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        commands: new Map<string, ICommandMetadata | undefined>([
          ['editor.action.format', { description: 'Format Document', category: 'Editor' }],
          ['_internal.hop', { description: 'Hidden' }],
          ['no.metadata', undefined],
          ['no.description', { category: 'Editor' }],
        ]),
      }),
    )
    expect(model.byPrecedence.map((r) => r.command)).toEqual(['editor.action.format'])
    const row = model.byPrecedence[0]!
    expect(row.keybinding).toBeUndefined()
    expect(row.chords).toEqual([])
    expect(row.commandLabel).toBe('Editor: Format Document')
    expect(row.isDefault).toBe(true)
  })

  it('classifies source as system / extension / user', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [
          { key: 'ctrl+1', command: 'sys.cmd', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+2', command: 'ext.weight.cmd', weight: KeybindingWeight.ExternalExtension },
          { key: 'ctrl+3', command: 'ext.attr.cmd', weight: KeybindingWeight.WorkbenchContrib },
        ],
        userEntries: [{ command: 'user.cmd', key: 'ctrl+u' }],
        extensionIdOf: (command) =>
          command === 'ext.weight.cmd'
            ? 'pub.weight'
            : command === 'ext.attr.cmd'
              ? 'pub.attr'
              : undefined,
        extensionLabelOf: (id) => (id === 'pub.weight' ? 'Weight Ext' : undefined),
      }),
    )
    expect(rowsByCommand(model.byPrecedence, 'sys.cmd')[0]!.source).toEqual({ kind: 'system' })
    expect(rowsByCommand(model.byPrecedence, 'ext.weight.cmd')[0]!.source).toEqual({
      kind: 'extension',
      extensionId: 'pub.weight',
      extensionLabel: 'Weight Ext',
    })
    // Attribution hit without a known label falls back to the extension id.
    expect(rowsByCommand(model.byPrecedence, 'ext.attr.cmd')[0]!.source).toEqual({
      kind: 'extension',
      extensionId: 'pub.attr',
      extensionLabel: 'pub.attr',
    })
    expect(rowsByCommand(model.byPrecedence, 'user.cmd')[0]!.source).toEqual({ kind: 'user' })
  })

  it('falls back to a generic Extension label when weight says extension but attribution is unknown', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [
          { key: 'ctrl+9', command: 'ext.anon', weight: KeybindingWeight.ExternalExtension },
        ],
      }),
    )
    expect(model.byPrecedence[0]!.source).toEqual({
      kind: 'extension',
      extensionId: undefined,
      extensionLabel: 'Extension',
    })
  })

  it('adds Monaco default rows only for commands absent from the registry', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [
          { key: 'ctrl+z', command: 'undo', weight: KeybindingWeight.MonacoDefault },
        ],
        monacoDefaults: new Map<string, DecodedKeybinding>([
          ['undo', { key: 'ctrl+z' }],
          ['redo', { key: 'ctrl+y' }],
          ['editor.action.chord', { chords: ['ctrl+k', 'ctrl+s'] }],
        ]),
      }),
    )
    expect(rowsByCommand(model.byPrecedence, 'undo')).toHaveLength(1)
    expect(rowsByCommand(model.byPrecedence, 'redo')[0]).toMatchObject({
      keybinding: 'ctrl+y',
      source: { kind: 'system' },
    })
    expect(rowsByCommand(model.byPrecedence, 'editor.action.chord')[0]!.keybinding).toBe(
      'ctrl+k ctrl+s',
    )
  })

  it('decomposes keys into formatted chord segments for the UI label', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [
          {
            chords: ['ctrl+k', 'ctrl+s'],
            command: 'chord.cmd',
            weight: KeybindingWeight.WorkbenchContrib,
          },
        ],
      }),
    )
    expect(model.byPrecedence[0]!.chords).toEqual([
      ['Ctrl', 'K'],
      ['Ctrl', 'S'],
    ])
  })

  it('distincts rows by command|key|when|source id', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [
          { key: 'ctrl+d', command: 'dup', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+d', command: 'dup', weight: KeybindingWeight.WorkbenchContrib },
        ],
      }),
    )
    expect(model.byPrecedence).toHaveLength(1)
    expect(model.byPrecedence[0]!.id).toBe('dup|ctrl+d||system')
  })

  it('serializes when-clauses from both string and expression forms', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        registryEntries: [{ key: 'ctrl+e', command: 'with.when', when: 'editorFocus' }],
        userEntries: [{ command: 'user.when', key: 'ctrl+w', when: 'editorTextFocus' }],
      }),
    )
    expect(rowsByCommand(model.byPrecedence, 'with.when')[0]!.when).toBe('editorFocus')
    expect(rowsByCommand(model.byPrecedence, 'user.when')[0]!.when).toBe('editorTextFocus')
  })

  it('sorts alphabetically: bound first, then label, user row before default of same command', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        commands: new Map<string, ICommandMetadata | undefined>([
          ['cmd.zulu', { description: 'Zulu' }],
          ['cmd.beta', { description: 'Beta' }],
          ['cmd.alpha', { description: 'Alpha' }],
          ['cmd.same', { description: 'Same' }],
        ]),
        registryEntries: [
          { key: 'ctrl+1', command: 'cmd.zulu', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+2', command: 'cmd.beta', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+3', command: 'cmd.alpha', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'ctrl+4', command: 'cmd.same', weight: KeybindingWeight.WorkbenchContrib },
        ],
        userEntries: [{ command: 'cmd.same', key: 'ctrl+5' }],
      }),
    )
    expect(model.alphabetical.map((r) => `${r.command}:${r.keybinding ?? 'unbound'}`)).toEqual([
      'cmd.alpha:ctrl+3',
      'cmd.beta:ctrl+2',
      'cmd.same:ctrl+5', // same command: the user row (isDefault false) first
      'cmd.same:ctrl+4',
      'cmd.zulu:ctrl+1',
    ])
  })

  it('sorts unbound rows after all bound rows', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        commands: new Map<string, ICommandMetadata | undefined>([
          ['aaa.unbound', { description: 'AAA' }],
          ['zzz.bound', { description: 'ZZZ' }],
        ]),
        registryEntries: [
          { key: 'ctrl+1', command: 'zzz.bound', weight: KeybindingWeight.WorkbenchContrib },
        ],
      }),
    )
    expect(model.alphabetical.map((r) => r.command)).toEqual(['zzz.bound', 'aaa.unbound'])
  })

  it('assembles commandDefaultLabel from original metadata only when it differs', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        commands: new Map<string, ICommandMetadata | undefined>([
          [
            'cmd.localized',
            {
              description: '保存',
              category: '文件',
              originalDescription: 'Save',
              originalCategory: 'File',
            },
          ],
          [
            'cmd.english',
            {
              description: 'Save',
              category: 'File',
              originalDescription: 'Save',
              originalCategory: 'File',
            },
          ],
          ['cmd.nolabel', undefined],
        ]),
        registryEntries: [
          { key: 'ctrl+1', command: 'cmd.localized' },
          { key: 'ctrl+2', command: 'cmd.english' },
          { key: 'ctrl+3', command: 'cmd.nolabel' },
        ],
      }),
    )
    expect(rowsByCommand(model.byPrecedence, 'cmd.localized')[0]).toMatchObject({
      commandLabel: '文件: 保存',
      commandDefaultLabel: 'File: Save',
    })
    expect(rowsByCommand(model.byPrecedence, 'cmd.english')[0]!.commandDefaultLabel).toBeUndefined()
    // No metadata at all: the label falls back to the command id.
    expect(rowsByCommand(model.byPrecedence, 'cmd.nolabel')[0]).toMatchObject({
      commandLabel: 'cmd.nolabel',
      commandDefaultLabel: undefined,
    })
  })

  it('groups rows by normalized key for conflict counting', () => {
    const model = resolveKeybindingEntries(
      makeDeps({
        commands: new Map<string, ICommandMetadata | undefined>([
          ['cmd.unbound', { description: 'Unbound' }],
        ]),
        registryEntries: [
          // Modifier order differs; both normalize to the same key.
          { key: 'ctrl+shift+x', command: 'cmd.a', weight: KeybindingWeight.WorkbenchContrib },
          { key: 'shift+ctrl+x', command: 'cmd.b', weight: KeybindingWeight.WorkbenchContrib },
        ],
        userEntries: [{ command: 'cmd.c', key: 'Ctrl+Shift+X' }],
      }),
    )
    const group = model.byKey.get('ctrl+shift+x')
    expect(group?.map((r) => r.command)).toEqual(['cmd.b', 'cmd.a', 'cmd.c'])
    expect(model.byKey.has('')).toBe(false)
    expect([...model.byKey.keys()]).toEqual(['ctrl+shift+x'])
  })

  it('keeps row ids stable across equivalent resolves', () => {
    const deps = makeDeps({
      registryEntries: [
        {
          key: 'ctrl+p',
          command: 'quickOpen',
          when: '!inPicker',
          weight: KeybindingWeight.WorkbenchContrib,
        },
      ],
    })
    const first = resolveKeybindingEntries(deps).byPrecedence[0]!
    const second = resolveKeybindingEntries(deps).byPrecedence[0]!
    expect(first.id).toBe(second.id)
    expect(first.id).toBe('quickOpen|ctrl+p|!inPicker|system')
  })
})
