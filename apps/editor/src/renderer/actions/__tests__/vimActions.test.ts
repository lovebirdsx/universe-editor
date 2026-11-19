/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  `workbench.action.vim.showActiveKeymap` diagnostic dump: active surface,
 *  effective keymap, user overrides, reserved keys and User-shadowed strokes.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IContextKeyService,
  IOutputService,
  InstantiationService,
  KeybindingsRegistry,
  KeybindingWeight,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import type { IVimKeymapEntry } from '@universe-editor/workbench-ui'
import { IVimModeService, type IVimActiveSurface } from '../../services/vim/vimModeService.js'
import { ShowActiveVimKeymapAction } from '../vimActions.js'

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

interface HarnessOptions {
  readonly activeSurface?: IVimActiveSurface
  readonly entries?: readonly IVimKeymapEntry[]
  readonly userKeymap?: readonly IVimKeymapEntry[]
  readonly reservedKeys?: readonly string[]
}

interface Harness {
  readonly lines: string[]
  run(): void
}

function harness(options: HarnessOptions = {}): Harness {
  const lines: string[] = []
  const channel = {
    clear: () => {
      lines.length = 0
    },
    appendLine: (line: string) => {
      lines.push(line)
    },
  }
  const activeSurface = options.activeSurface
  const vimModeService = {
    _serviceBrand: undefined,
    getEnabled: () => true,
    getLeader: () => 'space',
    activeSurface,
    getMode: (_key: string, fallback: string) => fallback,
    getEffectiveKeymap: () => options.entries ?? [],
    getUserKeymap: () => options.userKeymap ?? [],
    reservedKeys: options.reservedKeys ?? ['escape', 'ctrl+[', 'i', 'a', ':', '/', '?', 'space'],
  } as unknown as IVimModeService
  const contextKeyService = new ContextKeyService()
  const services = new ServiceCollection()
  services.set(IVimModeService, vimModeService)
  services.set(IOutputService, {
    _serviceBrand: undefined,
    createChannel: () => channel,
  } as never)
  services.set(IContextKeyService, contextKeyService)
  const instantiation = new InstantiationService(services)
  return {
    lines,
    run: () => {
      const registration = registerAction2(ShowActiveVimKeymapAction)
      try {
        instantiation.invokeFunction((accessor) => {
          const command = CommandsRegistry.getCommand(ShowActiveVimKeymapAction.ID)
          expect(command).toBeDefined()
          command!.handler(accessor)
        })
      } finally {
        registration.dispose()
        contextKeyService.dispose()
      }
    },
  }
}

function activeSurface(): IVimActiveSurface {
  return { surfaceKey: 'list:tree-1', kind: 'list', id: 'tree-1', defaultMode: 'normal' }
}

function bindUserKey(key: string, command: string): void {
  disposables.push(
    KeybindingsRegistry.registerKeybinding({
      key,
      command,
      weight: KeybindingWeight.User,
    }),
  )
}

function section(lines: readonly string[], header: string): readonly string[] {
  const index = lines.indexOf(header)
  return index === -1 ? [] : lines.slice(index + 1)
}

describe('ShowActiveVimKeymapAction', () => {
  it('prints the active surface, effective keymap and User-shadowed strokes', () => {
    bindUserKey('j', 'workbench.action.togglePanel')
    bindUserKey('shift+g', 'workbench.action.showCommands')
    bindUserKey('i', 'workbench.action.showCommands')
    const entries: readonly IVimKeymapEntry[] = [
      { id: 'list.focusDown', keys: ['j'], command: 'list.focusDown' },
      { id: 'list.focusLast', keys: ['G'], command: 'list.focusLast' },
      { id: 'custom.insert', keys: ['i'], command: 'app.insert' },
    ]
    const { lines, run } = harness({ activeSurface: activeSurface(), entries })
    run()

    expect(lines[0]).toContain('enabled=true')
    expect(lines[0]).toContain('leader=space')
    expect(lines).toContain('Active surface: list id=tree-1 key=list:tree-1 mode=normal')
    expect(lines).toContain('  j  →  list.focusDown')
    expect(lines).toContain('  G  →  list.focusLast')

    const shadowed = section(lines, 'Shadowed by User bindings:')
    expect(shadowed).toContain('  j → workbench.action.togglePanel')
    expect(shadowed).toContain('  G → workbench.action.showCommands')
    // `i` is reserved: Vim keeps the stroke even when the user binds it.
    expect(shadowed.some((line) => line.trimStart().startsWith('i → '))).toBe(false)
    expect(lines).toContain('  escape, ctrl+[, i, a, :, /, ?, space')
  })

  it('marks entries overridden through vim.keymap', () => {
    const override: IVimKeymapEntry = {
      id: 'list.focusDown',
      keys: ['n'],
      command: 'custom.down',
    }
    const { lines, run } = harness({
      activeSurface: activeSurface(),
      entries: [override],
      userKeymap: [override],
    })
    run()
    expect(lines).toContain('  n  →  custom.down  (user override)')
    expect(lines).toContain('  list.focusDown: n  →  custom.down')
  })

  it('says there is no active surface instead of inventing a kind', () => {
    const { lines, run } = harness()
    run()
    expect(lines).toContain(
      'Active surface: <none> (focus a Vim surface and run this command again)',
    )
    expect(lines).toContain('  <none — no active surface>')
  })

  it('prints empty sections explicitly', () => {
    const { lines, run } = harness({ activeSurface: activeSurface() })
    run()
    expect(lines).toContain('User overrides (vim.keymap): <none>')
    expect(section(lines, 'Shadowed by User bindings:')).toEqual(['  <none>'])
  })

  it('does not treat reserved keys as shadowed even when a User binding exists', () => {
    bindUserKey('escape', 'workbench.action.showCommands')
    const entries: readonly IVimKeymapEntry[] = [
      { id: 'surface.escape', keys: ['escape'], command: 'surface.escape' },
    ]
    const { lines, run } = harness({ activeSurface: activeSurface(), entries })
    run()
    expect(section(lines, 'Shadowed by User bindings:')).toEqual(['  <none>'])
  })
})
