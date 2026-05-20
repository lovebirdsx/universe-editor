/*---------------------------------------------------------------------------------------------
 *  Tests for ExplorerAutoRevealContribution — verifies that activeEditor changes
 *  are reflected in ExplorerTreeService.setActiveEditorResource and that
 *  reveal() is gated on the explorer.autoReveal setting.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfigurationRegistry,
  ConfigurationService,
  ConfigurationTarget,
  IConfigurationService,
  IEditorService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
  type IEditorInput,
} from '@universe-editor/platform'
import { ExplorerAutoRevealContribution } from '../ExplorerAutoRevealContribution.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from '../../services/explorer/ExplorerTreeService.js'

class FakeTree {
  declare readonly _serviceBrand: undefined
  activeEditorResource: URI | null = null
  revealCalls: string[] = []
  setActiveEditorResource(resource: URI | null): void {
    this.activeEditorResource = resource
  }
  async reveal(target: URI): Promise<boolean> {
    this.revealCalls.push(target.toString())
    return true
  }
}

function setup(autoReveal: boolean | undefined = undefined) {
  // Register a fresh schema node so ConfigurationService picks up the default.
  // We don't dispose because the registry is process-global and other tests
  // may rely on the same id being present.
  const reg = ConfigurationRegistry.registerConfiguration({
    id: 'explorer-test',
    title: 'Explorer Test',
    properties: {
      'explorer.autoReveal': {
        type: 'boolean',
        default: true,
        description: 'test default',
      },
    },
  })
  const services = new ServiceCollection()
  const active = observableValue<IEditorInput | undefined>('test.active', undefined)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor() {},
    closeEditor() {},
    closeAllEditors() {},
    openEditors: observableValue<readonly IEditorInput[]>('test.open', []),
    activeEditorId: observableValue<string | undefined>('test.activeId', undefined),
    activeEditor: active,
  } as unknown as IEditorService)
  const tree = new FakeTree()
  services.set(IExplorerTreeService, tree as unknown as ExplorerTreeService)
  const config = new ConfigurationService()
  if (autoReveal !== undefined) {
    config.update('explorer.autoReveal', autoReveal, ConfigurationTarget.Memory)
  }
  services.set(IConfigurationService, config)
  const inst = new InstantiationService(services)
  const contrib = inst.createInstance(ExplorerAutoRevealContribution)
  return { active, tree, config, inst, contrib, reg }
}

const wsRoot = URI.file('/ws')

describe('ExplorerAutoRevealContribution', () => {
  const disposables: { dispose(): void }[] = []
  afterEach(() => {
    while (disposables.length) disposables.pop()!.dispose()
  })

  it('mirrors a file editor as the tree active resource', () => {
    const { active, tree, inst, contrib, reg } = setup()
    disposables.push(contrib, reg)
    const input = inst.createInstance(FileEditorInput, URI.joinPath(wsRoot, 'a.txt'))
    active.set(input, undefined)
    expect(tree.activeEditorResource?.toString()).toBe(URI.joinPath(wsRoot, 'a.txt').toString())
  })

  it('reveals the file when explorer.autoReveal defaults to true', () => {
    const { active, tree, inst, contrib, reg } = setup()
    disposables.push(contrib, reg)
    const input = inst.createInstance(FileEditorInput, URI.joinPath(wsRoot, 'a.txt'))
    active.set(input, undefined)
    expect(tree.revealCalls).toEqual([URI.joinPath(wsRoot, 'a.txt').toString()])
  })

  it('updates the active marker but does not reveal when autoReveal is false', () => {
    const { active, tree, inst, contrib, reg } = setup(false)
    disposables.push(contrib, reg)
    const input = inst.createInstance(FileEditorInput, URI.joinPath(wsRoot, 'a.txt'))
    active.set(input, undefined)
    expect(tree.activeEditorResource?.toString()).toBe(URI.joinPath(wsRoot, 'a.txt').toString())
    expect(tree.revealCalls).toEqual([])
  })

  it('clears the active marker when there is no active file editor', () => {
    const { active, tree, inst, contrib, reg } = setup()
    disposables.push(contrib, reg)
    const input = inst.createInstance(FileEditorInput, URI.joinPath(wsRoot, 'a.txt'))
    active.set(input, undefined)
    active.set(undefined, undefined)
    expect(tree.activeEditorResource).toBeNull()
  })

  it('ignores non-file scheme editors', () => {
    const { active, tree, contrib, reg } = setup()
    disposables.push(contrib, reg)
    const fake: IEditorInput = {
      id: 'untitled:foo',
      typeId: 'untitled',
      isDirty: false,
      resolve: () => undefined,
      matches: () => false,
    } as unknown as IEditorInput
    active.set(fake, undefined)
    expect(tree.activeEditorResource).toBeNull()
    expect(tree.revealCalls).toEqual([])
  })
})
