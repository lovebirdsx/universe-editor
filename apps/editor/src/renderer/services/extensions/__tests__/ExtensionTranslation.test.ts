/*---------------------------------------------------------------------------------------------
 *  Tests for the renderer-side contribution translation:
 *  ExtensionPointTranslator (manifest commands → bootstrap proxies) and
 *  MainThreadCommands (runtime command registration from the host).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ConfigurationRegistry,
  JSONContributionRegistry,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  type ICommandService,
  type ServicesAccessor,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto, IExtHostCommands } from '@universe-editor/extensions-common'
import { ExtensionPointTranslator } from '../ExtensionPointTranslator.js'
import { MainThreadCommands } from '../MainThreadCommands.js'
import { EXTENSION_TREE_VIEW_COMPONENT_KEY } from '../../views/extensionViews.js'

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
    hasMain: true,
    extensionLocation: '/extensions/ext',
    extensionIsBuiltin: false,
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

  it('does not shadow a command id the core already registered (built-in Action2)', () => {
    // An extension may declare in its manifest a command id the core already
    // implements as a renderer Action2 (palette parity). A bootstrap proxy on
    // top would shadow the real handler and route execution to a host that
    // doesn't implement it.
    const core = CommandsRegistry.registerCommand({
      id: 'test.cmd',
      handler: () => 'from-core',
      metadata: { description: 'Core Title' },
    })
    disposables.push(core)
    const activate = vi.fn()
    const execute = vi.fn()
    const t = new ExtensionPointTranslator(activate, execute)
    disposables.push(t)
    t.translate([dto()])

    expect(CommandsRegistry.getCommand('test.cmd')?.metadata?.description).toBe('Core Title')
    expect(run('test.cmd')).toBe('from-core')
    expect(activate).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
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

  it('registers resolved jsonValidation schemas into the JSONContributionRegistry', () => {
    const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
    disposables.push(t)
    const schema = { type: 'object' as const, required: ['id'] }
    t.translate([
      dto({
        id: 'gc.ext',
        contributes: {
          jsonValidation: [{ fileMatch: ['**/*.entity.json'], schema }],
        },
      }),
    ])

    const contrib = JSONContributionRegistry.getContributions().find(
      (c) => c.uri === 'extension://gc.ext/jsonvalidation/0',
    )
    expect(contrib?.fileMatch).toEqual(['**/*.entity.json'])
    expect(contrib?.schema).toEqual(schema)
  })

  it('unregisters its jsonValidation schemas on dispose', () => {
    const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
    t.translate([
      dto({
        id: 'gc.ext',
        contributes: {
          jsonValidation: [{ fileMatch: ['**/*.entity.json'], schema: { type: 'object' } }],
        },
      }),
    ])
    const uri = 'extension://gc.ext/jsonvalidation/0'
    expect(JSONContributionRegistry.getContributions().some((c) => c.uri === uri)).toBe(true)
    t.dispose()
    expect(JSONContributionRegistry.getContributions().some((c) => c.uri === uri)).toBe(false)
  })

  it('resolves an http jsonValidation url via the injected resolver, then registers it', async () => {
    const schema = { type: 'object' as const, properties: { permissions: { type: 'object' } } }
    const resolve = vi.fn().mockResolvedValue(schema)
    const t = new ExtensionPointTranslator(vi.fn(), vi.fn(), resolve)
    disposables.push(t)
    t.translate([
      dto({
        id: 'claude.ext',
        contributes: {
          jsonValidation: [
            { fileMatch: ['**/.claude/settings.json'], url: 'https://example.com/s.json' },
          ],
        },
      }),
    ])

    await vi.waitFor(() => {
      const contrib = JSONContributionRegistry.getContributions().find(
        (c) => c.uri === 'extension://claude.ext/jsonvalidation/0',
      )
      expect(contrib?.schema).toEqual(schema)
    })
    expect(resolve).toHaveBeenCalledWith('https://example.com/s.json')
  })

  it('does not register an http jsonValidation url the resolver cannot resolve', async () => {
    const resolve = vi.fn().mockResolvedValue(undefined)
    const t = new ExtensionPointTranslator(vi.fn(), vi.fn(), resolve)
    disposables.push(t)
    t.translate([
      dto({
        id: 'claude.ext',
        contributes: {
          jsonValidation: [
            { fileMatch: ['**/.claude/settings.json'], url: 'https://blocked.example/s.json' },
          ],
        },
      }),
    ])

    await Promise.resolve()
    await Promise.resolve()
    const uri = 'extension://claude.ext/jsonvalidation/0'
    expect(JSONContributionRegistry.getContributions().some((c) => c.uri === uri)).toBe(false)
  })

  it('invokes the custom-editor callback for each contributed customEditor', () => {
    const registered: string[] = []
    const registerCustomEditor = vi.fn((editor: { viewType: string }) => {
      registered.push(editor.viewType)
      return { dispose: vi.fn() }
    })
    const t = new ExtensionPointTranslator(
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      registerCustomEditor,
    )
    disposables.push(t)
    t.translate([
      dto({
        id: 'pdf.ext',
        contributes: {
          customEditors: [
            {
              viewType: 'pdf.view',
              displayName: 'PDF View',
              selector: [{ filenamePattern: '*.pdf' }],
            },
          ],
        },
      }),
    ])
    expect(registered).toEqual(['pdf.view'])
    expect(registerCustomEditor).toHaveBeenCalledWith(
      expect.objectContaining({ viewType: 'pdf.view', displayName: 'PDF View' }),
    )
  })

  it('disposes custom-editor registrations when the translator is disposed', () => {
    const dispose = vi.fn()
    const registerCustomEditor = vi.fn(() => ({ dispose }))
    const t = new ExtensionPointTranslator(
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      registerCustomEditor,
    )
    t.translate([
      dto({
        id: 'pdf.ext',
        contributes: {
          customEditors: [
            {
              viewType: 'pdf.view',
              displayName: 'PDF View',
              selector: [{ filenamePattern: '*.pdf' }],
            },
          ],
        },
      }),
    ])
    t.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  describe('views / viewsContainers', () => {
    it('registers an activitybar container and its views with the shared componentKey', () => {
      const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
      disposables.push(t)
      t.translate([
        dto({
          contributes: {
            viewsContainers: {
              activitybar: [{ id: 'test.explorer', title: 'Test Explorer', icon: '$(files)' }],
            },
            views: {
              'test.explorer': [
                { id: 'test.view.a', name: 'A' },
                { id: 'test.view.b', name: 'B', when: 'false' },
              ],
            },
          },
        }),
      ])

      const container = ViewContainerRegistry.getViewContainer('test.explorer')
      expect(container).toMatchObject({
        label: 'Test Explorer',
        icon: 'files',
        location: ViewContainerLocation.SideBar,
      })
      expect(container!.order).toBeGreaterThanOrEqual(100)
      expect(ViewRegistry.getView('test.view.a')).toMatchObject({
        name: 'A',
        containerId: 'test.explorer',
        componentKey: EXTENSION_TREE_VIEW_COMPONENT_KEY,
        order: 0,
      })
      expect(ViewRegistry.getView('test.view.b')).toMatchObject({ order: 1 })
    })

    it('binds views under a built-in container alias (explorer)', () => {
      disposables.push(
        ViewContainerRegistry.registerViewContainer({
          id: 'workbench.view.explorer',
          label: 'Explorer',
          icon: 'files',
          order: 1,
          location: ViewContainerLocation.SideBar,
        }),
      )
      const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
      disposables.push(t)
      t.translate([
        dto({ contributes: { views: { explorer: [{ id: 'test.view.c', name: 'C' }] } } }),
      ])

      expect(ViewRegistry.getView('test.view.c')?.containerId).toBe('workbench.view.explorer')
    })

    it('binds views under a container referenced by its full id', () => {
      disposables.push(
        ViewContainerRegistry.registerViewContainer({
          id: 'workbench.view.search',
          label: 'Search',
          icon: 'search',
          order: 2,
          location: ViewContainerLocation.SideBar,
        }),
      )
      const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
      disposables.push(t)
      t.translate([
        dto({
          contributes: {
            views: { 'workbench.view.search': [{ id: 'test.view.d', name: 'D' }] },
          },
        }),
      ])

      expect(ViewRegistry.getView('test.view.d')?.containerId).toBe('workbench.view.search')
    })

    it('skips views whose container key resolves to nothing', () => {
      const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
      disposables.push(t)
      t.translate([
        dto({
          contributes: { views: { 'no.such.container': [{ id: 'test.view.e', name: 'E' }] } },
        }),
      ])

      expect(ViewRegistry.getView('test.view.e')).toBeUndefined()
    })

    it('skips a duplicate container id but still binds its views to the existing container', () => {
      disposables.push(
        ViewContainerRegistry.registerViewContainer({
          id: 'test.existing',
          label: 'Existing',
          icon: 'files',
          order: 1,
          location: ViewContainerLocation.SideBar,
        }),
      )
      const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
      disposables.push(t)
      t.translate([
        dto({
          contributes: {
            viewsContainers: {
              activitybar: [{ id: 'test.existing', title: 'Duplicate', icon: 'files' }],
            },
            views: { 'test.existing': [{ id: 'test.view.f', name: 'F' }] },
          },
        }),
      ])

      expect(ViewContainerRegistry.getViewContainer('test.existing')?.label).toBe('Existing')
      expect(ViewRegistry.getView('test.view.f')?.containerId).toBe('test.existing')
    })

    it('skips a view whose id is already registered instead of shadowing it', () => {
      disposables.push(
        ViewContainerRegistry.registerViewContainer({
          id: 'test.host',
          label: 'Host',
          icon: 'files',
          order: 1,
          location: ViewContainerLocation.SideBar,
        }),
      )
      disposables.push(
        ViewRegistry.registerView({
          id: 'test.view.g',
          name: 'Core',
          containerId: 'test.host',
          componentKey: 'core.view',
          order: 0,
        }),
      )
      const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
      disposables.push(t)
      t.translate([
        dto({ contributes: { views: { 'test.host': [{ id: 'test.view.g', name: 'Dup' }] } } }),
      ])

      expect(ViewRegistry.getView('test.view.g')?.componentKey).toBe('core.view')
    })

    it('assigns distinct deterministic container orders across extensions (sorted by extension id)', () => {
      const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
      disposables.push(t)
      t.translate([
        dto({
          id: 'zzz.ext',
          contributes: {
            viewsContainers: {
              activitybar: [{ id: 'zzz.container', title: 'Zzz', icon: 'files' }],
            },
          },
        }),
        dto({
          id: 'aaa.ext',
          contributes: {
            viewsContainers: {
              activitybar: [{ id: 'aaa.container', title: 'Aaa', icon: 'files' }],
            },
          },
        }),
        dto({
          id: 'mmm.ext',
          contributes: {
            viewsContainers: {
              activitybar: [
                { id: 'mid.container', title: 'Mid', icon: 'files' },
                { id: 'last.container', title: 'Last', icon: 'files' },
              ],
            },
          },
        }),
      ])

      const orders = ['zzz.container', 'aaa.container', 'mid.container', 'last.container'].map(
        (id) => ViewContainerRegistry.getViewContainer(id)!.order,
      )
      // No collisions: each container must get its own slot (the per-extension
      // index base made every first container collide on 100).
      expect(new Set(orders).size).toBe(orders.length)
      // Deterministic regardless of the scan order the host handed us: slots are
      // allocated after sorting extensions by id, so a restart that scans the
      // same install set in a different order yields the same activity-bar order.
      const [zzz, aaa, mid, last] = orders
      expect(aaa).toBeLessThan(mid!)
      expect(mid).toBeLessThan(last!)
      expect(last).toBeLessThan(zzz!)
    })

    it('binds views to a container declared by another extension later in the same set', () => {
      // VSCode registers all viewsContainers before any views, so the load order
      // of extensions is irrelevant; a forward reference must not drop the view.
      const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
      disposables.push(t)
      t.translate([
        dto({
          id: 'b.ext',
          contributes: {
            views: { 'a.container': [{ id: 'b.forward.view', name: 'Forward' }] },
          },
        }),
        dto({
          id: 'a.ext',
          contributes: {
            viewsContainers: {
              activitybar: [{ id: 'a.container', title: 'A Container', icon: 'files' }],
            },
          },
        }),
      ])

      expect(ViewRegistry.getView('b.forward.view')?.containerId).toBe('a.container')
    })

    it('unregisters its containers and views on dispose', () => {
      const t = new ExtensionPointTranslator(vi.fn(), vi.fn())
      t.translate([
        dto({
          contributes: {
            viewsContainers: {
              activitybar: [{ id: 'test.gone', title: 'Gone', icon: 'files' }],
            },
            views: { 'test.gone': [{ id: 'test.view.gone', name: 'Gone' }] },
          },
        }),
      ])
      expect(ViewContainerRegistry.getViewContainer('test.gone')).toBeDefined()
      expect(ViewRegistry.getView('test.view.gone')).toBeDefined()
      t.dispose()
      expect(ViewContainerRegistry.getViewContainer('test.gone')).toBeUndefined()
      expect(ViewRegistry.getView('test.view.gone')).toBeUndefined()
    })
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
