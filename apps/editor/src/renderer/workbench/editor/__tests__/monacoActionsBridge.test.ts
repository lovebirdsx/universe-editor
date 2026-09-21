/*---------------------------------------------------------------------------------------------
 *  Tests for monacoActionsBridge — feed a fake EditorExtensionsRegistry, verify
 *  the bridge populates CommandsRegistry + the default-keybinding side-table,
 *  and that dispose() reverses both sides cleanly.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  EditorInput,
  IEditorGroupsService,
  INotificationService,
  InstantiationService,
  KeybindingsRegistry,
  KeybindingWeight,
  ServiceCollection,
  URI,
  type IDisposable,
} from '@universe-editor/platform'
import {
  bridgeMonacoActionsForTests as bridgeAll,
  CORE_COMMANDS,
  getAllMonacoDefaultKeybindings,
  getMonacoDefaultKeybinding,
  resolvePlatformRule,
  effectivePrimariesOf,
  type CoreCommand,
  type IMonacoEditorExtensionsRegistry,
  type MonacoPlatform,
} from '../monaco/monacoActionsBridge.js'
import {
  MONACO_COMPAT_KEYBINDINGS,
  type IMonacoCompatKeybinding,
} from '../monaco/monacoCompatKeybindings.js'
import { registerMonacoCommandKeybindings } from '../monaco/monacoCommandKeybindings.js'
import { MONACO_EXTRA_KEYBINDINGS } from '../monaco/monacoExtraKeybindings.js'
import { FileEditorRegistry } from '../../../services/editor/FileEditorRegistry.js'

const CtrlCmd = 2048
const Shift = 1024
const Alt = 512
const KC_KeyF = 36
const KC_KeyZ = 56
const KC_KeyY = 55
const KC_KeyA = 31
const KC_KeyI = 39
const KC_F1 = 59
const KC_UpArrow = 16
const KC_DownArrow = 18
const KC_PageUp = 11
const KC_PageDown = 12

type NlsGlobals = { __MONACO_NLS__?: Record<string, string> }

function makeRegistry(
  actions: { id: string; label: string; _kbOpts?: unknown }[],
): IMonacoEditorExtensionsRegistry {
  return { getEditorActions: () => actions as never }
}

/**
 * The mirror on its own. The assertions below are about monaco facts; the two
 * added-key tables are product decisions tested separately, so both are opted
 * out of here to keep their entries from reshaping these expectations.
 */
function bridge(
  registry: IMonacoEditorExtensionsRegistry,
  coreCommands: readonly CoreCommand[],
  platform: MonacoPlatform = 'linux',
): IDisposable {
  return bridgeAll(registry, coreCommands, platform, [])
}

describe('bridgeMonacoActionsForTests', () => {
  let registered: IDisposable | undefined

  beforeEach(() => {
    delete (globalThis as NlsGlobals).__MONACO_NLS__
  })

  afterEach(() => {
    registered?.dispose()
    registered = undefined
    delete (globalThis as NlsGlobals).__MONACO_NLS__
  })

  it('registers each EditorAction into CommandsRegistry with label/category', () => {
    registered = bridge(
      makeRegistry([
        { id: 'editor.action.formatDocument', label: 'Format Document', _kbOpts: undefined },
        { id: 'editor.action.commentLine', label: 'Toggle Line Comment' },
      ]),
      [],
    )

    const cmds = CommandsRegistry.getCommands()
    expect(cmds.get('editor.action.formatDocument')?.metadata).toEqual({
      description: 'Format Document',
      category: 'Editor',
    })
    expect(cmds.get('editor.action.commentLine')?.metadata).toEqual({
      description: 'Toggle Line Comment',
      category: 'Editor',
    })
  })

  it('records the first decoded default keybinding for each action', () => {
    registered = bridge(
      makeRegistry([
        {
          id: 'editor.action.formatDocument',
          label: 'Format Document',
          _kbOpts: { primary: Shift | Alt | KC_KeyF },
        },
      ]),
      [],
    )
    expect(getMonacoDefaultKeybinding('editor.action.formatDocument')).toEqual({
      key: 'alt+shift+f',
    })
  })

  it('handles kbOpts as an array — takes the first non-zero primary', () => {
    registered = bridge(
      makeRegistry([
        {
          id: 'editor.action.foo',
          label: 'Foo',
          _kbOpts: [{ primary: 0 }, { primary: KC_F1 }, { primary: CtrlCmd | KC_KeyA }],
        },
      ]),
      [],
    )
    expect(getMonacoDefaultKeybinding('editor.action.foo')).toEqual({ key: 'f1' })
  })

  it('skips the default-keybinding map entry when the key code is unsupported', () => {
    registered = bridge(
      makeRegistry([
        {
          id: 'editor.action.bar',
          label: 'Bar',
          _kbOpts: { primary: CtrlCmd | 124 }, // 124 = MediaTrackNext, unsupported
        },
      ]),
      [],
    )
    // Command still registered for visibility in the shortcuts editor.
    expect(CommandsRegistry.getCommands().get('editor.action.bar')).toBeDefined()
    expect(getMonacoDefaultKeybinding('editor.action.bar')).toBeUndefined()
  })

  it('registers actions without kbOpts (command-only, no default key)', () => {
    registered = bridge(makeRegistry([{ id: 'editor.action.noKb', label: 'No KB' }]), [])
    expect(CommandsRegistry.getCommands().get('editor.action.noKb')).toBeDefined()
    expect(getMonacoDefaultKeybinding('editor.action.noKb')).toBeUndefined()
  })

  it('registers core commands (undo/redo/selectAll) with NLS labels and defaults', () => {
    ;(globalThis as NlsGlobals).__MONACO_NLS__ = {
      undo: '撤销',
      redo: '重做',
      'selectAll.label': '全选',
    }
    const coreCommands: CoreCommand[] = [
      { id: 'undo', label: 'Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ },
      { id: 'redo', label: 'Redo', nlsKey: 'redo', primary: CtrlCmd | KC_KeyY },
      {
        id: 'editor.action.selectAll',
        label: 'Select All',
        nlsKey: 'selectAll.label',
        primary: CtrlCmd | KC_KeyA,
      },
    ]
    registered = bridge(makeRegistry([]), coreCommands)

    const cmds = CommandsRegistry.getCommands()
    expect(cmds.get('undo')?.metadata?.description).toBe('撤销')
    expect(cmds.get('redo')?.metadata?.description).toBe('重做')
    expect(cmds.get('editor.action.selectAll')?.metadata?.description).toBe('全选')
    expect(getMonacoDefaultKeybinding('undo')).toEqual({ key: 'ctrl+z' })
    expect(getMonacoDefaultKeybinding('redo')).toEqual({ key: 'ctrl+y' })
    expect(getMonacoDefaultKeybinding('editor.action.selectAll')).toEqual({ key: 'ctrl+a' })
  })

  it('falls back to labelKey (localize) when the NLS table has no entry', () => {
    const coreCommands: CoreCommand[] = [
      {
        id: 'cursorColumnSelectUp',
        label: 'Column Select Up',
        nlsKey: 'Column Select Up',
        labelKey: 'monaco.command.columnSelectUp',
      },
    ]
    registered = bridge(makeRegistry([]), coreCommands)
    // No configureNls / no table entry → English defaultMessage wins.
    expect(CommandsRegistry.getCommands().get('cursorColumnSelectUp')?.metadata?.description).toBe(
      'Column Select Up',
    )
  })

  it('registers cursor column selection core commands with VSCode default keys', () => {
    const coreCommands: CoreCommand[] = [
      {
        id: 'cursorColumnSelectUp',
        label: 'Column Select Up',
        keybindings: [
          { primary: CtrlCmd | Shift | Alt | KC_UpArrow, when: 'editorTextFocus' },
          {
            primary: Shift | KC_UpArrow,
            when: 'editorTextFocus && editorColumnSelection',
          },
        ],
      },
      {
        id: 'cursorColumnSelectDown',
        label: 'Column Select Down',
        keybindings: [
          { primary: CtrlCmd | Shift | Alt | KC_DownArrow, when: 'editorTextFocus' },
          {
            primary: Shift | KC_DownArrow,
            when: 'editorTextFocus && editorColumnSelection',
          },
        ],
      },
    ]

    registered = bridge(makeRegistry([]), coreCommands)

    const cmds = CommandsRegistry.getCommands()
    expect(cmds.get('cursorColumnSelectUp')?.metadata).toEqual({
      description: 'Column Select Up',
      category: 'Editor',
    })
    expect(cmds.get('cursorColumnSelectDown')?.metadata).toEqual({
      description: 'Column Select Down',
      category: 'Editor',
    })
    expect(getMonacoDefaultKeybinding('cursorColumnSelectUp')).toEqual({
      key: 'alt+ctrl+shift+arrowup',
    })
    expect(getMonacoDefaultKeybinding('cursorColumnSelectDown')).toEqual({
      key: 'alt+ctrl+shift+arrowdown',
    })

    const bindings = KeybindingsRegistry.getAllKeybindings()
      .filter(
        (kb) => kb.command === 'cursorColumnSelectUp' || kb.command === 'cursorColumnSelectDown',
      )
      .map((kb) => ({
        command: kb.command,
        key: kb.key,
        when: typeof kb.when === 'string' ? kb.when : kb.when?.serialize(),
        weight: kb.weight,
      }))
      .sort((a, b) => `${a.command}:${a.key}`.localeCompare(`${b.command}:${b.key}`))

    expect(bindings).toEqual([
      {
        command: 'cursorColumnSelectDown',
        key: 'alt+ctrl+shift+down',
        when: 'editorTextFocus',
        weight: KeybindingWeight.MonacoDefault,
      },
      {
        command: 'cursorColumnSelectDown',
        key: 'shift+down',
        when: 'editorColumnSelection && editorTextFocus',
        weight: KeybindingWeight.MonacoDefault,
      },
      {
        command: 'cursorColumnSelectUp',
        key: 'alt+ctrl+shift+up',
        when: 'editorTextFocus',
        weight: KeybindingWeight.MonacoDefault,
      },
      {
        command: 'cursorColumnSelectUp',
        key: 'shift+up',
        when: 'editorColumnSelection && editorTextFocus',
        weight: KeybindingWeight.MonacoDefault,
      },
    ])
  })

  it('falls back to English when NLS table is missing the key', () => {
    const coreCommands: CoreCommand[] = [
      { id: 'undo', label: 'Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ },
    ]
    registered = bridge(makeRegistry([]), coreCommands)
    expect(CommandsRegistry.getCommands().get('undo')?.metadata?.description).toBe('Undo')
  })

  it('deduplicates: an EditorAction id wins over a core command of the same id', () => {
    const coreCommands: CoreCommand[] = [
      { id: 'undo', label: 'Core Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ },
    ]
    registered = bridge(
      makeRegistry([{ id: 'undo', label: 'Action Undo', _kbOpts: { primary: CtrlCmd | KC_KeyZ } }]),
      coreCommands,
    )
    expect(CommandsRegistry.getCommands().get('undo')?.metadata?.description).toBe('Action Undo')
    expect(getMonacoDefaultKeybinding('undo')).toEqual({ key: 'ctrl+z' })
  })

  it('exposes all defaults via getAllMonacoDefaultKeybindings()', () => {
    registered = bridge(
      makeRegistry([
        {
          id: 'editor.action.formatDocument',
          label: 'Format Document',
          _kbOpts: { primary: Shift | Alt | KC_KeyF },
        },
      ]),
      [{ id: 'undo', label: 'Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ }],
    )
    const all = getAllMonacoDefaultKeybindings()
    expect(all.size).toBe(2)
    expect(all.get('editor.action.formatDocument')).toEqual({ key: 'alt+shift+f' })
    expect(all.get('undo')).toEqual({ key: 'ctrl+z' })
  })

  it('dispose() removes both the command and the default-keybinding entry', () => {
    registered = bridge(
      makeRegistry([
        {
          id: 'editor.action.demo',
          label: 'Demo',
          _kbOpts: { primary: CtrlCmd | KC_KeyA },
        },
      ]),
      [{ id: 'undo', label: 'Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ }],
    )
    expect(CommandsRegistry.getCommands().get('editor.action.demo')).toBeDefined()
    expect(getMonacoDefaultKeybinding('editor.action.demo')).toBeDefined()
    expect(getMonacoDefaultKeybinding('undo')).toBeDefined()

    registered.dispose()
    registered = undefined
    expect(CommandsRegistry.getCommands().get('editor.action.demo')).toBeUndefined()
    expect(CommandsRegistry.getCommands().get('undo')).toBeUndefined()
    expect(getMonacoDefaultKeybinding('editor.action.demo')).toBeUndefined()
    expect(getMonacoDefaultKeybinding('undo')).toBeUndefined()
  })

  it('registers the default key into KeybindingsRegistry at MonacoDefault weight, gated on editorFocus', () => {
    registered = bridge(
      makeRegistry([
        {
          id: 'editor.action.formatDocument',
          label: 'Format Document',
          _kbOpts: { primary: Shift | Alt | KC_KeyF },
        },
      ]),
      [],
    )
    const bound = KeybindingsRegistry.getAllKeybindings().filter(
      (kb) => kb.command === 'editor.action.formatDocument',
    )
    expect(bound).toHaveLength(1)
    expect(bound[0]!.key).toBe('alt+shift+f')
    expect(bound[0]!.weight).toBe(KeybindingWeight.MonacoDefault)
    const when = bound[0]!.when
    expect(typeof when === 'string' ? when : when?.serialize()).toBe('editorFocus')
  })

  it('registers ALL distinct primaries from a kbOpts array, not just the first', () => {
    registered = bridge(
      makeRegistry([
        {
          id: 'editor.action.multi',
          label: 'Multi',
          _kbOpts: [{ primary: KC_F1 }, { primary: CtrlCmd | KC_KeyA }],
        },
      ]),
      [],
    )
    const keys = KeybindingsRegistry.getAllKeybindings()
      .filter((kb) => kb.command === 'editor.action.multi')
      .map((kb) => kb.key)
      .sort()
    expect(keys).toEqual(['ctrl+a', 'f1'])
  })

  it('dispose() removes the registry bindings too', () => {
    registered = bridge(
      makeRegistry([
        { id: 'editor.action.demo', label: 'Demo', _kbOpts: { primary: CtrlCmd | KC_KeyA } },
      ]),
      [],
    )
    expect(
      KeybindingsRegistry.getAllKeybindings().some((kb) => kb.command === 'editor.action.demo'),
    ).toBe(true)
    registered.dispose()
    registered = undefined
    expect(
      KeybindingsRegistry.getAllKeybindings().some((kb) => kb.command === 'editor.action.demo'),
    ).toBe(false)
  })

  describe('command handler editor resolution', () => {
    class FakeTextInput extends EditorInput {
      override get typeId(): string {
        return 'fakeText'
      }
      override get resource(): URI {
        return URI.parse('untitled:///Fake-1')
      }
      getName(): string {
        return 'Fake-1'
      }
    }

    function setup(activeEditor: EditorInput | null) {
      const trigger = vi.fn()
      const status = vi.fn()
      const services = new ServiceCollection()
      services.set(IEditorGroupsService, {
        _serviceBrand: undefined,
        activeGroup: { id: 1, activeEditor },
      } as never)
      services.set(INotificationService, { _serviceBrand: undefined, status } as never)
      const inst = new InstantiationService(services)
      return { inst, trigger, status }
    }

    afterEach(() => {
      FileEditorRegistry._resetForTests()
    })

    it('dispatches to a mounted editor even when the active input is not a FileEditorInput', () => {
      registered = bridge(
        makeRegistry([{ id: 'editor.action.insertCursorBelow', label: 'Add Cursor Below' }]),
        [],
      )
      const input = new FakeTextInput()
      const { inst, trigger } = setup(input)
      FileEditorRegistry.register(input, { trigger } as never, 1)

      inst.invokeFunction((accessor) => {
        CommandsRegistry.getCommand('editor.action.insertCursorBelow')!.handler(accessor)
      })
      expect(trigger).toHaveBeenCalledWith('', 'editor.action.insertCursorBelow', {})
    })

    it('notifies instead of throwing when no text editor is mounted', () => {
      registered = bridge(
        makeRegistry([{ id: 'editor.action.insertCursorBelow', label: 'Add Cursor Below' }]),
        [],
      )
      const { inst, status } = setup(null)

      inst.invokeFunction((accessor) => {
        CommandsRegistry.getCommand('editor.action.insertCursorBelow')!.handler(accessor)
      })
      expect(status).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * The kbOpts fixtures below are copied verbatim from the monaco 0.55 esm sources
 * of the actions they name. Platform resolution is the only place win32/mac
 * behaviour is exercised at all — the e2e suite runs on Linux — so these
 * fixtures have to be the real shapes, not convenient ones.
 */
const COPY_LINES_UP = {
  primary: Alt | Shift | KC_UpArrow,
  linux: { primary: CtrlCmd | Alt | Shift | KC_UpArrow },
}
const INSERT_CURSOR_ABOVE = {
  primary: CtrlCmd | Alt | KC_UpArrow,
  linux: { primary: Shift | Alt | KC_UpArrow, secondary: [CtrlCmd | Shift | KC_UpArrow] },
}
const BLOCK_COMMENT = {
  primary: Shift | Alt | KC_KeyA,
  linux: { primary: CtrlCmd | Shift | KC_KeyA },
}
const FORMAT_DOCUMENT = {
  primary: Shift | Alt | KC_KeyF,
  linux: { primary: CtrlCmd | Shift | KC_KeyI },
}

describe('resolvePlatformRule / effectivePrimariesOf', () => {
  it('a platform block replaces the whole rule — the base primary is not a fallback', () => {
    const rule = {
      primary: Alt | Shift | KC_UpArrow,
      linux: { primary: CtrlCmd | Alt | Shift | KC_UpArrow },
    }
    expect(resolvePlatformRule(rule, 'win32').primary).toBe(Alt | Shift | KC_UpArrow)
    expect(resolvePlatformRule(rule, 'darwin').primary).toBe(Alt | Shift | KC_UpArrow)
    expect(resolvePlatformRule(rule, 'linux').primary).toBe(CtrlCmd | Alt | Shift | KC_UpArrow)
  })

  it('primary: 0 on a platform means "no key here", and yields nothing', () => {
    const rule = { primary: CtrlCmd | Shift | Alt | KC_UpArrow, linux: { primary: 0 } }
    expect(resolvePlatformRule(rule, 'linux').primary).toBe(0)
    expect(effectivePrimariesOf(rule, 'win32')).toEqual([CtrlCmd | Shift | Alt | KC_UpArrow])
    expect(effectivePrimariesOf(rule, 'linux')).toEqual([])
  })

  it('dedupes primaries across a rule array, keeping registration order', () => {
    const kbOpts = [
      { primary: KC_F1 },
      { primary: KC_F1 },
      { primary: CtrlCmd | KC_KeyA },
      { primary: 0 },
    ]
    expect(effectivePrimariesOf(kbOpts, 'linux')).toEqual([KC_F1, CtrlCmd | KC_KeyA])
  })

  it('accepts a single rule, a rule array, and nothing at all', () => {
    expect(effectivePrimariesOf({ primary: KC_F1 }, 'linux')).toEqual([KC_F1])
    expect(effectivePrimariesOf([], 'linux')).toEqual([])
    expect(effectivePrimariesOf(undefined, 'linux')).toEqual([])
  })

  it('resolves a platform block nested inside an array', () => {
    const kbOpts = [{ primary: KC_F1, linux: { primary: CtrlCmd | KC_KeyI } }]
    expect(effectivePrimariesOf(kbOpts, 'win32')).toEqual([KC_F1])
    expect(effectivePrimariesOf(kbOpts, 'linux')).toEqual([CtrlCmd | KC_KeyI])
  })
})

describe('the mirror follows the current platform', () => {
  let registered: IDisposable | undefined

  afterEach(() => {
    registered?.dispose()
    registered = undefined
  })

  function mirrorFor(platform: MonacoPlatform): void {
    registered?.dispose()
    registered = bridge(
      makeRegistry([
        { id: 'editor.action.copyLinesUpAction', label: 'Copy Line Up', _kbOpts: COPY_LINES_UP },
        {
          id: 'editor.action.insertCursorAbove',
          label: 'Add Cursor Above',
          _kbOpts: INSERT_CURSOR_ABOVE,
        },
        { id: 'editor.action.blockComment', label: 'Toggle Block Comment', _kbOpts: BLOCK_COMMENT },
        { id: 'editor.action.formatDocument', label: 'Format Document', _kbOpts: FORMAT_DOCUMENT },
      ]),
      [],
      platform,
    )
  }

  /** Registry keys of a command's MonacoDefault rows, in canonical order. */
  function mirroredKeys(commandId: string): string[] {
    return KeybindingsRegistry.getAllKeybindings()
      .filter((kb) => kb.command === commandId)
      .map((kb) => kb.key ?? kb.chords!.join(' '))
      .sort()
  }

  it('linux mirrors the linux blocks — and drops the base key they replace', () => {
    mirrorFor('linux')

    expect(mirroredKeys('editor.action.copyLinesUpAction')).toEqual(['alt+ctrl+shift+up'])
    expect(mirroredKeys('editor.action.insertCursorAbove')).toEqual(['alt+shift+up'])
    expect(mirroredKeys('editor.action.blockComment')).toEqual(['ctrl+shift+a'])
    expect(mirroredKeys('editor.action.formatDocument')).toEqual(['ctrl+shift+i'])

    // The base keys are *gone* on linux, not mirrored alongside. `alt+shift+a`
    // showing up as block-comment on Linux was the phantom row this replaces.
    const all = KeybindingsRegistry.getAllKeybindings().map((kb) => kb.key)
    expect(all).not.toContain('alt+shift+a')
    expect(all).not.toContain('alt+shift+f')
    expect(all).not.toContain('ctrl+alt+up')
  })

  it('win32 mirrors the base rules', () => {
    mirrorFor('win32')

    expect(mirroredKeys('editor.action.copyLinesUpAction')).toEqual(['alt+shift+up'])
    expect(mirroredKeys('editor.action.insertCursorAbove')).toEqual(['alt+ctrl+up'])
    expect(mirroredKeys('editor.action.blockComment')).toEqual(['alt+shift+a'])
    expect(mirroredKeys('editor.action.formatDocument')).toEqual(['alt+shift+f'])
  })

  it('darwin mirrors the base rules (none of these four have a mac block)', () => {
    mirrorFor('darwin')

    expect(mirroredKeys('editor.action.formatDocument')).toEqual(['alt+shift+f'])
    expect(mirroredKeys('editor.action.blockComment')).toEqual(['alt+shift+a'])
  })

  it('never mirrors a secondary — only primary', () => {
    mirrorFor('linux')
    // INSERT_CURSOR_ABOVE's linux secondary is ctrl+shift+up; mirroring it would
    // add a second MonacoDefault row to a command that already has one.
    expect(mirroredKeys('editor.action.insertCursorAbove')).toHaveLength(1)
  })

  it('records the platform-effective key as the "built-in" default', () => {
    mirrorFor('linux')
    expect(getMonacoDefaultKeybinding('editor.action.formatDocument')).toEqual({
      key: 'ctrl+shift+i',
    })

    mirrorFor('win32')
    expect(getMonacoDefaultKeybinding('editor.action.formatDocument')).toEqual({
      key: 'alt+shift+f',
    })
  })
})

describe('core commands follow the current platform', () => {
  let registered: IDisposable | undefined

  const CORE_COMMANDS_FIXTURE: readonly CoreCommand[] = [
    {
      id: 'cursorColumnSelectUp',
      label: 'Column Select Up',
      labelKey: 'monaco.command.columnSelectUp',
      keybindings: [
        // coreCommands.js:383 — monaco disables this on linux; the second entry
        // is ours (column-selection mode), so it must survive the platform pass.
        {
          primary: CtrlCmd | Shift | Alt | KC_UpArrow,
          when: 'editorTextFocus',
          linux: { primary: 0 },
        },
        { primary: Shift | KC_UpArrow, when: 'editorTextFocus && editorColumnSelection' },
      ],
    },
    {
      id: 'scrollPageUp',
      label: 'Scroll Page Up',
      labelKey: 'monaco.command.scrollPageUp',
      keybindings: [
        {
          primary: CtrlCmd | KC_PageUp,
          win: { primary: Alt | KC_PageUp },
          linux: { primary: Alt | KC_PageUp },
        },
      ],
    },
    {
      id: 'scrollPageDown',
      label: 'Scroll Page Down',
      labelKey: 'monaco.command.scrollPageDown',
      keybindings: [
        {
          primary: CtrlCmd | KC_PageDown,
          win: { primary: Alt | KC_PageDown },
          linux: { primary: Alt | KC_PageDown },
        },
      ],
    },
  ]

  afterEach(() => {
    registered?.dispose()
    registered = undefined
  })

  function mirrorCore(platform: MonacoPlatform): void {
    registered?.dispose()
    registered = bridge(makeRegistry([]), CORE_COMMANDS_FIXTURE, platform)
  }

  function coreKeys(commandId: string): string[] {
    return KeybindingsRegistry.getAllKeybindings()
      .filter((kb) => kb.command === commandId)
      .map((kb) => kb.key!)
      .sort()
  }

  it('linux drops the column-select primary monaco disables there', () => {
    mirrorCore('linux')
    expect(coreKeys('cursorColumnSelectUp')).toEqual(['shift+up'])
    // The side-table keeps the decoder's long token form — it is fed to the
    // Keyboard Shortcuts editor, which normalizes on its own.
    expect(getMonacoDefaultKeybinding('cursorColumnSelectUp')).toEqual({ key: 'shift+arrowup' })
  })

  it('win32 keeps both column-select primaries', () => {
    mirrorCore('win32')
    expect(coreKeys('cursorColumnSelectUp')).toEqual(['alt+ctrl+shift+up', 'shift+up'])
    expect(getMonacoDefaultKeybinding('cursorColumnSelectUp')).toEqual({
      key: 'alt+ctrl+shift+arrowup',
    })
  })

  it('scroll-page is Alt+PageUp on win32/linux and Ctrl+PageUp elsewhere', () => {
    mirrorCore('linux')
    expect(coreKeys('scrollPageUp')).toEqual(['alt+pageup'])
    expect(coreKeys('scrollPageDown')).toEqual(['alt+pagedown'])

    mirrorCore('win32')
    expect(coreKeys('scrollPageUp')).toEqual(['alt+pageup'])

    mirrorCore('darwin')
    expect(coreKeys('scrollPageUp')).toEqual(['ctrl+pageup'])
    expect(coreKeys('scrollPageDown')).toEqual(['ctrl+pagedown'])
  })

  it('registers the scroll-page commands so their keys have something to run', () => {
    mirrorCore('linux')
    const cmds = CommandsRegistry.getCommands()
    expect(cmds.get('scrollPageUp')?.metadata?.description).toBe('Scroll Page Up')
    expect(cmds.get('scrollPageDown')?.metadata?.description).toBe('Scroll Page Down')
  })
})

describe('the shipped CORE_COMMANDS table', () => {
  let registered: IDisposable | undefined

  afterEach(() => {
    registered?.dispose()
    registered = undefined
  })

  /** The shipped table — not a fixture, so a drift in it fails right here. */
  function mirrorShipped(platform: MonacoPlatform): void {
    registered?.dispose()
    registered = bridge(makeRegistry([]), CORE_COMMANDS, platform)
  }

  function shippedKeys(commandId: string): string[] {
    return KeybindingsRegistry.getAllKeybindings()
      .filter((kb) => kb.command === commandId)
      .map((kb) => kb.key!)
      .sort()
  }

  it('linux: scroll-page is Alt+PageUp, and column-select loses its disabled primary', () => {
    mirrorShipped('linux')
    expect(shippedKeys('scrollPageUp')).toEqual(['alt+pageup'])
    expect(shippedKeys('scrollPageDown')).toEqual(['alt+pagedown'])
    expect(shippedKeys('cursorColumnSelectUp')).toEqual(['shift+up'])
    expect(shippedKeys('cursorColumnSelectDown')).toEqual(['shift+down'])
  })

  it('win32: scroll-page is Alt+PageUp and column-select keeps both primaries', () => {
    mirrorShipped('win32')
    expect(shippedKeys('scrollPageUp')).toEqual(['alt+pageup'])
    expect(shippedKeys('cursorColumnSelectUp')).toEqual(['alt+ctrl+shift+up', 'shift+up'])
    expect(shippedKeys('cursorColumnSelectDown')).toEqual(['alt+ctrl+shift+down', 'shift+down'])
  })

  it('darwin: scroll-page falls back to the base Ctrl+PageUp', () => {
    mirrorShipped('darwin')
    expect(shippedKeys('scrollPageUp')).toEqual(['ctrl+pageup'])
    expect(shippedKeys('scrollPageDown')).toEqual(['ctrl+pagedown'])
  })

  it('undo / redo / selectAll are platform-independent', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      mirrorShipped(platform)
      expect(shippedKeys('undo'), platform).toEqual(['ctrl+z'])
      expect(shippedKeys('redo'), platform).toEqual(['ctrl+y'])
      expect(shippedKeys('editor.action.selectAll'), platform).toEqual(['ctrl+a'])
    }
  })

  it('every shipped command is reachable in the command palette', () => {
    mirrorShipped('linux')
    const cmds = CommandsRegistry.getCommands()
    for (const core of CORE_COMMANDS) {
      expect(cmds.get(core.id)?.metadata?.category, core.id).toBe('Editor')
    }
  })
})

describe('monaco compat keybindings', () => {
  let registered: IDisposable | undefined

  const MOVE_UP = MONACO_COMPAT_KEYBINDINGS.find((b) => b.id === 'editor.action.moveLinesUpAction')!
  const COPY_DOWN = MONACO_COMPAT_KEYBINDINGS.find(
    (b) => b.id === 'editor.action.copyLinesDownAction',
  )!

  /** Two entries are enough to pin the mechanism; the table itself is checked below. */
  const FIXTURE: readonly IMonacoCompatKeybinding[] = [MOVE_UP, COPY_DOWN]

  afterEach(() => {
    registered?.dispose()
    registered = undefined
  })

  function bindFixture(): void {
    registered = bridgeAll(
      makeRegistry([
        { id: MOVE_UP.id, label: 'Move Line Up' },
        { id: COPY_DOWN.id, label: 'Copy Line Down' },
      ]),
      [],
      'linux',
      [FIXTURE],
    )
  }

  it('registers the alternative key above MonacoDefault', () => {
    bindFixture()
    const item = KeybindingsRegistry.getAllKeybindings().find(
      (kb) => kb.command === MOVE_UP.id && kb.key === MOVE_UP.key,
    )
    expect(item).toBeDefined()
    expect(item!.weight).toBe(KeybindingWeight.WorkbenchContrib)
    // The dispatcher defers (no preventDefault) at MonacoDefault and monaco has
    // no binding for these keys — a compat entry at that weight would be dead.
    expect(item!.weight).toBeGreaterThan(KeybindingWeight.MonacoDefault)
  })

  it('gates the key on the when-clause, evaluated against a real context', () => {
    bindFixture()
    const context = new ContextKeyService()

    context.set('editorTextFocus', true)
    context.set('isInMergeEditor', false)
    context.set('isLinux', true)
    expect(KeybindingsRegistry.resolveKeybinding(MOVE_UP.key, context)).toBe(MOVE_UP.id)
    expect(KeybindingsRegistry.resolveKeybinding(COPY_DOWN.key, context)).toBe(COPY_DOWN.id)

    context.set('isInMergeEditor', true)
    expect(KeybindingsRegistry.resolveKeybinding(MOVE_UP.key, context)).toBeUndefined()
    expect(KeybindingsRegistry.resolveKeybinding(COPY_DOWN.key, context)).toBeUndefined()
    context.set('isInMergeEditor', false)

    context.set('editorTextFocus', false)
    expect(KeybindingsRegistry.resolveKeybinding(MOVE_UP.key, context)).toBeUndefined()
    context.set('editorTextFocus', true)

    // The linux-only entries really are linux-only.
    context.set('isLinux', false)
    expect(KeybindingsRegistry.resolveKeybinding(COPY_DOWN.key, context)).toBeUndefined()
    expect(KeybindingsRegistry.resolveKeybinding(MOVE_UP.key, context)).toBe(MOVE_UP.id)
  })

  it('skips entries whose command does not exist instead of swallowing the key', () => {
    const disposables = registerMonacoCommandKeybindings([
      { ...MOVE_UP, id: 'editor.action.doesNotExist' },
    ])
    try {
      expect(
        KeybindingsRegistry.getAllKeybindings().some(
          (kb) => kb.command === 'editor.action.doesNotExist',
        ),
      ).toBe(false)
    } finally {
      disposables.dispose()
    }
  })

  it('dispose() removes the alternative keys', () => {
    bindFixture()
    expect(KeybindingsRegistry.getAllKeybindings().some((kb) => kb.command === MOVE_UP.id)).toBe(
      true,
    )

    registered!.dispose()
    registered = undefined
    expect(KeybindingsRegistry.getAllKeybindings().some((kb) => kb.command === MOVE_UP.id)).toBe(
      false,
    )
  })

  it('every shipped entry is editor-scoped, distinct and self-documenting', () => {
    expect(MONACO_COMPAT_KEYBINDINGS).toHaveLength(8)
    expect(new Set(MONACO_COMPAT_KEYBINDINGS.map((b) => b.id)).size).toBe(
      MONACO_COMPAT_KEYBINDINGS.length,
    )
    expect(new Set(MONACO_COMPAT_KEYBINDINGS.map((b) => b.key)).size).toBe(
      MONACO_COMPAT_KEYBINDINGS.length,
    )
    for (const binding of MONACO_COMPAT_KEYBINDINGS) {
      // Scoping every entry to editor text focus is what keeps an alternative
      // key from claiming the global key space.
      expect(binding.when, binding.id).toContain('editorTextFocus')
      // Both halves a reader needs to judge the entry: what got taken, by what.
      expect(binding.nativeKey, binding.id).not.toBe('')
      expect(binding.takenBy, binding.id).not.toBe('')
    }
  })
})

describe('the keys this editor adds on top of the mirror', () => {
  let registered: IDisposable | undefined

  const SORT_UP = MONACO_EXTRA_KEYBINDINGS.find((b) => b.id === 'editor.action.sortLinesAscending')!
  const SORT_DOWN = MONACO_EXTRA_KEYBINDINGS.find(
    (b) => b.id === 'editor.action.sortLinesDescending',
  )!

  afterEach(() => {
    registered?.dispose()
    registered = undefined
  })

  function bindExtraKeys(): void {
    registered = bridgeAll(
      makeRegistry([
        { id: SORT_UP.id, label: 'Sort Lines Ascending' },
        { id: SORT_DOWN.id, label: 'Sort Lines Descending' },
      ]),
      [],
      'linux',
      [MONACO_EXTRA_KEYBINDINGS],
    )
  }

  it('gives F9 / Shift+F9 to the sort actions above MonacoDefault', () => {
    bindExtraKeys()
    for (const binding of [SORT_UP, SORT_DOWN]) {
      const item = KeybindingsRegistry.getAllKeybindings().find(
        (kb) => kb.command === binding.id && kb.key === binding.key,
      )
      expect(item, binding.id).toBeDefined()
      expect(item!.weight).toBe(KeybindingWeight.WorkbenchContrib)
      // Monaco ships these two actions keyless, so a deferred binding at
      // MonacoDefault would have nothing to hand the keystroke to.
      expect(item!.weight).toBeGreaterThan(KeybindingWeight.MonacoDefault)
    }
  })

  it('gates the keys on the when-clause, evaluated against a real context', () => {
    bindExtraKeys()
    const context = new ContextKeyService()

    context.set('editorTextFocus', true)
    context.set('isInMergeEditor', false)
    context.set('editorReadonly', false)
    expect(KeybindingsRegistry.resolveKeybinding(SORT_UP.key, context)).toBe(SORT_UP.id)
    expect(KeybindingsRegistry.resolveKeybinding(SORT_DOWN.key, context)).toBe(SORT_DOWN.id)

    // The actions are writable-gated in monaco: in a read-only editor the key
    // could only run a no-op, so it must not claim the keystroke.
    context.set('editorReadonly', true)
    expect(KeybindingsRegistry.resolveKeybinding(SORT_UP.key, context)).toBeUndefined()
    expect(KeybindingsRegistry.resolveKeybinding(SORT_DOWN.key, context)).toBeUndefined()
    context.set('editorReadonly', false)

    context.set('isInMergeEditor', true)
    expect(KeybindingsRegistry.resolveKeybinding(SORT_UP.key, context)).toBeUndefined()
    context.set('isInMergeEditor', false)

    context.set('editorTextFocus', false)
    expect(KeybindingsRegistry.resolveKeybinding(SORT_UP.key, context)).toBeUndefined()
  })

  it('every shipped entry is editor-scoped and distinct, and never shadows a compat key', () => {
    expect(MONACO_EXTRA_KEYBINDINGS).toHaveLength(2)
    expect(new Set(MONACO_EXTRA_KEYBINDINGS.map((b) => b.id)).size).toBe(
      MONACO_EXTRA_KEYBINDINGS.length,
    )
    for (const binding of MONACO_EXTRA_KEYBINDINGS) {
      expect(binding.when, binding.id).toContain('editorTextFocus')
      expect(binding.when, binding.id).toContain('editorReadonly')
    }
    const keys = [...MONACO_COMPAT_KEYBINDINGS, ...MONACO_EXTRA_KEYBINDINGS].map((b) => b.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
