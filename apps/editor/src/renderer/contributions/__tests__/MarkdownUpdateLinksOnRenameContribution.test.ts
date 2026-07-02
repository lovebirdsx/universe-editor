/*---------------------------------------------------------------------------------------------
 *  Tests for MarkdownUpdateLinksOnRenameContribution — verifies the rename event
 *  is gated on the `markdown.updateLinksOnFileMove.enabled` setting, filtered to
 *  markdown/asset files + directories, debounced into one call, and forwarded to
 *  the plugin's `markdown.getRenameFileEdits` command with the right DTO. The
 *  Monaco apply path (edit present) is covered by the plugin test + e2e; here the
 *  command returns no edit so we assert the wiring up to that point.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigurationRegistry,
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  IConfigurationService,
  IDialogService,
  IInstantiationService,
  ILoggerService,
  InstantiationService,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import { MarkdownUpdateLinksOnRenameContribution } from '../MarkdownUpdateLinksOnRenameContribution.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
  type IFileRenameOperation,
} from '../../services/explorer/ExplorerTreeService.js'
import { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'

ConfigurationRegistry.registerConfiguration({
  id: 'markdown-update-links-test',
  title: 'Markdown Update Links Test',
  properties: {
    'markdown.updateLinksOnFileMove.enabled': {
      type: 'string',
      enum: ['never', 'prompt', 'always'],
      default: 'prompt',
      description: 'test default',
    },
  },
})

interface CommandCall {
  readonly id: string
  readonly args: unknown[]
}

function setup(setting?: 'never' | 'prompt' | 'always') {
  const onDidRunFileOperation = new Emitter<readonly IFileRenameOperation[]>()
  const services = new ServiceCollection()

  services.set(IExplorerTreeService, {
    onDidRunFileOperation: onDidRunFileOperation.event,
  } as unknown as ExplorerTreeService)

  const commandCalls: CommandCall[] = []
  const activations: string[] = []
  services.set(IExtensionHostClientService, {
    _serviceBrand: undefined,
    activateByEvent: (event: string) => {
      activations.push(event)
      return Promise.resolve()
    },
    executeContributedCommand: (id: string, args: unknown[]) => {
      commandCalls.push({ id, args })
      return Promise.resolve(null) // no edits → stops before the Monaco apply path
    },
  } as unknown as IExtensionHostClientService)

  const config = new ConfigurationService()
  if (setting)
    config.update('markdown.updateLinksOnFileMove.enabled', setting, ConfigurationTarget.Memory)
  services.set(IConfigurationService, config)

  const confirmCalls: unknown[] = []
  services.set(IDialogService, {
    _serviceBrand: undefined,
    confirm: (opts: unknown) => {
      confirmCalls.push(opts)
      return Promise.resolve({ confirmed: true, choice: 'primary' })
    },
    prompt: () => Promise.resolve(undefined),
  } as unknown as IDialogService)

  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => ({
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
    }),
  } as unknown as ILoggerService)

  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  const contrib = inst.createInstance(MarkdownUpdateLinksOnRenameContribution)
  return { onDidRunFileOperation, commandCalls, activations, confirmCalls, contrib }
}

const md = (name: string): IFileRenameOperation => ({
  oldUri: URI.file(`/ws/${name}-old.md`),
  newUri: URI.file(`/ws/${name}.md`),
  isDirectory: false,
})

describe('MarkdownUpdateLinksOnRenameContribution', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not call the plugin when the setting is "never"', async () => {
    const { onDidRunFileOperation, commandCalls, contrib } = setup('never')
    onDidRunFileOperation.fire([md('a')])
    await vi.runAllTimersAsync()
    expect(commandCalls).toEqual([])
    contrib.dispose()
  })

  it('calls the plugin for a markdown rename (default prompt setting)', async () => {
    const { onDidRunFileOperation, commandCalls, activations, contrib } = setup()
    onDidRunFileOperation.fire([md('a')])
    await vi.runAllTimersAsync()
    expect(activations).toContain('onLanguage:markdown')
    expect(commandCalls).toHaveLength(1)
    expect(commandCalls[0]?.id).toBe('markdown.getRenameFileEdits')
    const renames = commandCalls[0]?.args[0] as { oldUri: string; newUri: string }[]
    expect(renames[0]?.newUri).toBe(URI.file('/ws/a.md').toString())
    contrib.dispose()
  })

  it('ignores non-markdown, non-asset files', async () => {
    const { onDidRunFileOperation, commandCalls, contrib } = setup()
    onDidRunFileOperation.fire([
      { oldUri: URI.file('/ws/a-old.txt'), newUri: URI.file('/ws/a.txt'), isDirectory: false },
    ])
    await vi.runAllTimersAsync()
    expect(commandCalls).toEqual([])
    contrib.dispose()
  })

  it('participates for image assets and directories', async () => {
    const { onDidRunFileOperation, commandCalls, contrib } = setup()
    onDidRunFileOperation.fire([
      { oldUri: URI.file('/ws/x-old.png'), newUri: URI.file('/ws/x.png'), isDirectory: false },
      { oldUri: URI.file('/ws/dir-old'), newUri: URI.file('/ws/dir'), isDirectory: true },
    ])
    await vi.runAllTimersAsync()
    expect(commandCalls).toHaveLength(1)
    const renames = commandCalls[0]?.args[0] as unknown[]
    expect(renames).toHaveLength(2)
    contrib.dispose()
  })

  it('debounces a burst of renames into a single call', async () => {
    const { onDidRunFileOperation, commandCalls, contrib } = setup()
    onDidRunFileOperation.fire([md('a')])
    onDidRunFileOperation.fire([md('b')])
    await vi.runAllTimersAsync()
    expect(commandCalls).toHaveLength(1)
    const renames = commandCalls[0]?.args[0] as unknown[]
    expect(renames).toHaveLength(2)
    contrib.dispose()
  })
})
