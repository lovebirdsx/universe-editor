/*---------------------------------------------------------------------------------------------
 *  Tests for the renderer-side contribution translation:
 *  ExtensionPointTranslator (manifest commands → bootstrap proxies) and
 *  MainThreadCommands (runtime command registration from the host).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ConfigurationRegistry,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  type ICommandService,
  type ServicesAccessor,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto, IExtHostCommands } from '@universe-editor/extensions-common'
import { ExtensionPointTranslator } from '../ExtensionPointTranslator.js'
import { MainThreadCommands } from '../MainThreadCommands.js'

const accessor = {} as ServicesAccessor

function run(id: string, ...args: unknown[]): unknown {
  const cmd = CommandsRegistry.getCommand(id)
  if (!cmd) throw new Error(`no command ${id}`)
  return cmd.handler(accessor, ...args)
}

function dto(overrides: Partial<IExtensionDescriptionDto> = {}): IExtensionDescriptionDto {
  return {
    id: 'test.ext',
    name: 'ext',
    activationEvents: ['onCommand:test.cmd'],
    contributes: { commands: [{ command: 'test.cmd', title: 'Test Command', category: 'Test' }] },
    ...overrides,
  }
}

describe('ExtensionPointTranslator', () => {
  const disposables: { dispose(): void }[] = []
  afterEach(() => {
    for (const d of disposables.splice(0)) d.dispose()
  })

  it('registers a contributed command with palette metadata', () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    const execute = vi.fn().mockResolvedValue('ok')
    const t = new ExtensionPointTranslator(activate, execute)
    disposables.push(t)
    t.translate([dto()])

    const cmd = CommandsRegistry.getCommand('test.cmd')
    expect(cmd?.metadata?.description).toBe('Test Command')
    expect(cmd?.metadata?.category).toBe('Test')
  })

  it('fires the activation event then executes in the host on first invocation', async () => {
    const order: string[] = []
    const activate = vi.fn((e: string) => {
      order.push(`activate:${e}`)
      return Promise.resolve()
    })
    const execute = vi.fn((id: string, args: unknown[]) => {
      order.push(`execute:${id}:${JSON.stringify(args)}`)
      return Promise.resolve('done')
    })
    const t = new ExtensionPointTranslator(activate, execute)
    disposables.push(t)
    t.translate([dto()])

    await expect(run('test.cmd', 1, 2)).resolves.toBe('done')
    expect(order).toEqual(['activate:onCommand:test.cmd', 'execute:test.cmd:[1,2]'])
  })

  it('unregisters its commands on dispose', () => {
    const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
    t.translate([dto()])
    expect(CommandsRegistry.getCommand('test.cmd')).toBeDefined()
    t.dispose()
    expect(CommandsRegistry.getCommand('test.cmd')).toBeUndefined()
  })

  it('translates menu contributions into the MenuRegistry, parsing group@order', () => {
    const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
    disposables.push(t)
    t.translate([
      dto({
        contributes: {
          menus: {
            'scm/title': [
              {
                command: 'test.cmd',
                group: 'navigation@2',
                when: 'scmProvider == git',
                icon: 'git-commit',
              },
            ],
          },
        },
      }),
    ])

    const items = MenuRegistry.getMenuItems(MenuId.ScmTitle)
    const item = items.find((i) => 'command' in i && i.command === 'test.cmd')
    expect(item).toBeDefined()
    expect(item && 'group' in item ? item.group : undefined).toBe('navigation')
    expect(item && 'order' in item ? item.order : undefined).toBe(2)
    expect(item && 'icon' in item ? item.icon : undefined).toBe('git-commit')
  })

  it('ignores an unknown menu location instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
    disposables.push(t)
    expect(() =>
      t.translate([dto({ contributes: { menus: { 'bogus/location': [{ command: 'x' }] } } })]),
    ).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('translates a chord keybinding into the KeybindingsRegistry', () => {
    const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
    disposables.push(t)
    t.translate([
      dto({
        contributes: { keybindings: [{ command: 'test.cmd', key: 'ctrl+k ctrl+s' }] },
      }),
    ])

    const res = KeybindingsRegistry.resolveKeystroke('ctrl+k')
    expect(res.kind).toBe('enter-chord')
  })

  it('translates configuration into the ConfigurationRegistry', () => {
    const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
    disposables.push(t)
    t.translate([
      dto({
        id: 'cfg.ext',
        contributes: {
          configuration: {
            title: 'Cfg',
            properties: { 'cfg.autofetch': { type: 'boolean', default: true } },
          },
        },
      }),
    ])

    expect(ConfigurationRegistry.getDefaultValue('cfg.autofetch')).toBe(true)
  })
})

describe('MainThreadCommands', () => {
  const disposables: { dispose(): void }[] = []
  afterEach(() => {
    for (const d of disposables.splice(0)) d.dispose()
  })

  function make(): {
    mt: MainThreadCommands
    execute: ReturnType<typeof vi.fn>
    commandExecute: ReturnType<typeof vi.fn>
    ledger: { claim: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
  } {
    const execute = vi.fn().mockResolvedValue('host-result')
    const extHost: IExtHostCommands = { $executeContributedCommand: execute }
    const commandExecute = vi.fn().mockResolvedValue('cmd-result')
    const commandService = { executeCommand: commandExecute } as unknown as ICommandService
    const ledger = { claim: vi.fn(), release: vi.fn() }
    const mt = new MainThreadCommands(extHost, commandService, ledger)
    disposables.push(mt)
    return { mt, execute, commandExecute, ledger }
  }

  it('registers a forwarding handler for a runtime command', async () => {
    const { mt, execute } = make()
    await mt.$registerCommand('runtime.cmd')

    await expect(run('runtime.cmd', 'x')).resolves.toBe('host-result')
    expect(execute).toHaveBeenCalledWith('runtime.cmd', ['x'])
  })

  it('does not override a command already registered (manifest bootstrap proxy)', async () => {
    const existing = CommandsRegistry.registerCommand({
      id: 'dup.cmd',
      handler: () => 'from-proxy',
      metadata: { description: 'Proxy Title' },
    })
    disposables.push(existing)

    const { mt } = make()
    await mt.$registerCommand('dup.cmd')

    expect(CommandsRegistry.getCommand('dup.cmd')?.metadata?.description).toBe('Proxy Title')
    expect(run('dup.cmd')).toBe('from-proxy')
  })

  it('unregisters a previously registered runtime command', async () => {
    const { mt } = make()
    await mt.$registerCommand('runtime.cmd')
    expect(CommandsRegistry.getCommand('runtime.cmd')).toBeDefined()
    await mt.$unregisterCommand('runtime.cmd')
    expect(CommandsRegistry.getCommand('runtime.cmd')).toBeUndefined()
  })

  it('executes a _workbench.* built-in on behalf of the host', async () => {
    const { mt, commandExecute } = make()
    await expect(mt.$executeCommand('_workbench.openDiff', [{ title: 't' }])).resolves.toBe(
      'cmd-result',
    )
    expect(commandExecute).toHaveBeenCalledWith('_workbench.openDiff', { title: 't' })
  })

  it('refuses to execute a non-_workbench command from the host (loop guard)', async () => {
    const { mt, commandExecute } = make()
    await expect(mt.$executeCommand('git.commit', [])).rejects.toThrow(/_workbench/)
    expect(commandExecute).not.toHaveBeenCalled()
  })

  it('claims and releases command ownership through the ledger', async () => {
    const { mt, ledger } = make()
    await mt.$registerCommand('runtime.cmd')
    expect(ledger.claim).toHaveBeenCalledWith('runtime.cmd')
    await mt.$unregisterCommand('runtime.cmd')
    expect(ledger.release).toHaveBeenCalledWith('runtime.cmd')
  })
})
