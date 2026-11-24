/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The application half of the built-in Vim keymap: workbench commands, leader
 *  chords and context-keyed entries that the generic workbench-ui table must not
 *  know about.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  VIM_DEFAULT_KEYMAP,
  type IVimKeymapEntry,
  type VimSurfaceKind,
} from '@universe-editor/workbench-ui'
import { VIM_APP_KEYMAP } from '../vimAppKeymap.js'
import { VIM_SURFACE_KEYMAPS } from '../vimSurfaceKeymaps.js'
import { entryAppliesTo } from '../vimKeymapMerge.js'

function entriesFor(kind: VimSurfaceKind, keys: readonly string[]): IVimKeymapEntry[] {
  return VIM_APP_KEYMAP.filter(
    (entry) =>
      entryAppliesTo(entry, kind, ';') &&
      entry.keys.length === keys.length &&
      entry.keys.every((key, index) => key === keys[index]),
  )
}

function commandFor(kind: VimSurfaceKind, keys: readonly string[]): string | undefined {
  return entriesFor(kind, keys)[0]?.command
}

describe('VIM_APP_KEYMAP', () => {
  it('chat-only i/a/e/j/k map to the existing agent commands while acpChatFocused', () => {
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['i', 'workbench.action.agent.focusInput'],
      ['a', 'workbench.action.agent.scrollTimelineToTop'],
      ['e', 'workbench.action.agent.scrollTimelineToBottom'],
      ['j', 'workbench.action.agent.scrollTimelineDown'],
      ['k', 'workbench.action.agent.scrollTimelineUp'],
    ]
    for (const [key, command] of expectations) {
      const entry = entriesFor('list', [key]).find((candidate) => candidate.command === command)
      expect(entry, `${key} -> ${command}`).toBeDefined()
      expect(entry?.when).toBe('acpChatFocused')
    }
  })

  it('navigates compare-editor hunks from a list while a diff is visible', () => {
    for (const [keys, command] of [
      [[']', 'c'], 'workbench.action.compareEditor.nextChange'],
      [['[', 'c'], 'workbench.action.compareEditor.previousChange'],
    ] as const) {
      const entry = entriesFor('list', keys).find((candidate) => candidate.command === command)
      expect(entry, keys.join(' ')).toBeDefined()
      expect(entry?.when).toBe('textCompareEditorVisible')
      expect(commandFor('menu', keys)).toBeUndefined()
      expect(commandFor('editor', keys)).toBeUndefined()
    }
  })

  it('terminal motion reuses the generic list commands', () => {
    expect(commandFor('terminal', ['j'])).toBe('list.focusDown')
    expect(commandFor('terminal', ['k'])).toBe('list.focusUp')
    expect(commandFor('terminal', ['ctrl+e'])).toBe('list.scrollViewportDown')
    expect(commandFor('terminal', ['ctrl+y'])).toBe('list.scrollViewportUp')
    expect(commandFor('terminal', ['g', 'g'])).toBe('list.focusFirst')
    expect(commandFor('terminal', ['G'])).toBe('list.focusLast')
    expect(commandFor('terminal', ['v'])).toBe('workbench.action.terminal.normalStartSelection')
    expect(commandFor('terminal', ['escape'])).toBe('surface.escape')
  })

  it('editor leader aliases stay on the editor surface', () => {
    const expectations = [
      [['<leader>', 'd'], 'editor.action.revealDefinition'],
      [['<leader>', 'D'], 'editor.action.peekDefinition'],
      [['<leader>', 'r'], 'editor.action.goToReferences'],
      [['<leader>', 'R'], 'editor.action.referenceSearch.trigger'],
      [['<leader>', 'y'], 'editor.action.goToTypeDefinition'],
      [['<leader>', 'i'], 'editor.action.goToImplementation'],
      [['<leader>', 'k'], 'editor.action.showHover'],
      [['<leader>', 'a'], 'editor.action.quickFix'],
      [['<leader>', 'c'], 'editor.action.commentLine'],
      [['<leader>', 'm'], 'editor.action.rename'],
      [['<leader>', 'F'], 'editor.action.formatDocument'],
      [['<leader>', 'I'], 'editor.action.organizeImports'],
      [['<leader>', 'G'], 'editor.action.gotoLine'],
      [['<leader>', 'O'], 'workbench.action.gotoSymbol'],
      [['<leader>', 'S'], 'workbench.action.showAllSymbols'],
      [['<leader>', 'h'], 'workbench.action.goBack'],
      [['<leader>', 'l'], 'workbench.action.goForward'],
      [['<leader>', 'z'], 'editor.gotoParentFold'],
    ] as const
    for (const [keys, command] of expectations) {
      expect(commandFor('editor', keys), keys.join(' ')).toBe(command)
      expect(commandFor('list', keys), keys.join(' ')).toBeUndefined()
    }
  })

  it('terminal table: scrolling, selection and every way out of Normal mode', () => {
    expect(commandFor('terminal', ['ctrl+d'])).toBe('list.pageDown')
    expect(commandFor('terminal', ['ctrl+u'])).toBe('list.pageUp')
    expect(commandFor('terminal', ['ctrl+f'])).toBe(
      'workbench.action.terminal.normalScrollPageDown',
    )
    expect(commandFor('terminal', ['ctrl+b'])).toBe('workbench.action.terminal.normalScrollPageUp')
    expect(commandFor('terminal', ['y'])).toBe('workbench.action.terminal.normalCopySelection')
    for (const key of ['i', 'a', 'q']) {
      expect(commandFor('terminal', [key]), key).toBe('workbench.action.terminal.exitNormalMode')
    }
    // terminal-only keys must not leak onto lists
    for (const key of ['ctrl+f', 'y', 'q']) {
      expect(commandFor('list', [key])?.startsWith('workbench.action.terminal.') ?? false).toBe(
        false,
      )
    }
  })

  it('window chords split right/down and close the whole group', () => {
    expect(commandFor('editor', ['<leader>', 'w', 'v'])).toBe('workbench.action.splitEditorRight')
    expect(commandFor('editor', ['<leader>', 'w', 's'])).toBe('workbench.action.splitEditorDown')
    expect(commandFor('editor', ['<leader>', 'w', 'c'])).toBe(
      'workbench.action.closeEditorsInGroup',
    )
  })

  it('window chords move the active editor into adjacent groups', () => {
    expect(commandFor('editor', ['<leader>', 'w', 'H'])).toBe(
      'workbench.action.moveEditorToLeftGroup',
    )
    expect(commandFor('editor', ['<leader>', 'w', 'J'])).toBe(
      'workbench.action.moveEditorToBelowGroup',
    )
    expect(commandFor('editor', ['<leader>', 'w', 'K'])).toBe(
      'workbench.action.moveEditorToAboveGroup',
    )
    expect(commandFor('editor', ['<leader>', 'w', 'L'])).toBe(
      'workbench.action.moveEditorToRightGroup',
    )
    // Case-sensitive tokens: lowercase still focuses, uppercase moves.
    expect(commandFor('editor', ['<leader>', 'w', 'h'])).toBe('workbench.action.focusLeftGroup')
    // Leader entries are not editor-only: a focused list moves the active tab too.
    expect(commandFor('list', ['<leader>', 'w', 'H'])).toBe(
      'workbench.action.moveEditorToLeftGroup',
    )
  })

  it('<leader>? opens the key cheat sheet on every surface', () => {
    expect(commandFor('list', ['<leader>', '?'])).toBe('workbench.action.vim.showKeymapCheatSheet')
    expect(commandFor('editor', ['<leader>', '?'])).toBe(
      'workbench.action.vim.showKeymapCheatSheet',
    )
  })

  it('leader chords without surfaces reach every non-editor surface and the editor', () => {
    expect(commandFor('list', ['<leader>', 'f'])).toBe('workbench.action.quickOpen')
    expect(commandFor('editor', ['<leader>', 'f'])).toBe('workbench.action.quickOpen')
    expect(commandFor('tabs', ['<leader>', 'e'])).toBe('workbench.view.explorer')
  })

  it('has globally unique ids across the default, app and surface tables', () => {
    const ids = [...VIM_DEFAULT_KEYMAP, ...VIM_APP_KEYMAP, ...VIM_SURFACE_KEYMAPS].map(
      (entry) => entry.id,
    )
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
    expect(duplicates).toEqual([])
  })

  it('only binds commands that exist', () => {
    const missing = unresolvedCommands([
      ...VIM_DEFAULT_KEYMAP,
      ...VIM_APP_KEYMAP,
      ...VIM_SURFACE_KEYMAPS,
    ])
    expect(missing).toEqual([])
  })
})

// A command id typo is silent at runtime: the dispatcher just logs a failed
// executeCommand. Registration happens at bootstrap (Action2 classes, Monaco's
// action bridge, extensions), so resolve ids statically against their declarations.
const RENDERER_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const EXTENSION_COMMANDS = new Set(['perforce-graph.focusSearch', 'git-graph.focusSearch'])

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full)
  }
  return acc
}

function declaredIds(): ReadonlySet<string> {
  const ids = new Set<string>()
  const pattern = /(?:\bID\s*=|\bid:|registerCommand\(\s*)\s*'([^']+)'/g

  for (const file of walk(RENDERER_ROOT)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(pattern)) ids.add(match[1]!)
  }
  return ids
}

function monacoEditorIds(): ReadonlySet<string> {
  const require = createRequire(import.meta.url)
  const root = path.join(path.dirname(require.resolve('monaco-editor/package.json')), 'esm', 'vs')
  const ids = new Set<string>()
  const pattern = /['"](editor\.[A-Za-z.]+)['"]/g
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name.endsWith('.js')) {
        for (const match of readFileSync(full, 'utf8').matchAll(pattern)) ids.add(match[1]!)
      }
    }
  }
  visit(path.join(root, 'editor'))
  return ids
}

function unresolvedCommands(entries: readonly IVimKeymapEntry[]): string[] {
  const declared = declaredIds()
  const monaco = monacoEditorIds()
  const missing = new Set<string>()
  for (const { command } of entries) {
    if (EXTENSION_COMMANDS.has(command)) continue
    if (command.startsWith('editor.') ? monaco.has(command) : declared.has(command)) continue
    missing.add(command)
  }
  return [...missing].sort()
}
