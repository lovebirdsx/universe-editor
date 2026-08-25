/*---------------------------------------------------------------------------------------------
 *  Tests for ExplorerClipboardContextContribution — the shared file clipboard
 *  is mirrored one-way into the Explorer tree's local clipboard state and the
 *  fileCopied / explorerResourceCut context keys. No event may ever flow back
 *  into the shared service (writeResources/clear) from the adopt path.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  IContextKeyService,
  InstantiationService,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import { ExplorerClipboardContextContribution } from '../ExplorerClipboardContextContribution.js'
import {
  IExplorerTreeService,
  type IExplorerResourceOperation,
} from '../../services/explorer/ExplorerTreeService.js'
import type { ExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'
import {
  IFileClipboardService,
  type IFileClipboardResource,
  type IFileClipboardSnapshot,
} from '../../../shared/ipc/fileClipboardService.js'

class FakeTree {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChangeClipboard = new Emitter<void>()
  readonly onDidChangeClipboard = this._onDidChangeClipboard.event
  private _resources: readonly IExplorerResourceOperation[] = []
  private _isCut = false
  readonly adopted: Array<{
    resources: readonly IExplorerResourceOperation[]
    isCut: boolean
  }> = []

  adoptClipboard(resources: readonly IExplorerResourceOperation[], isCut: boolean): void {
    this.adopted.push({ resources, isCut })
    this._resources = resources
    this._isCut = isCut
    this._onDidChangeClipboard.fire()
  }

  get hasClipboard(): boolean {
    return this._resources.length > 0
  }

  get hasCutItems(): boolean {
    return this._isCut && this._resources.length > 0
  }

  clearClipboard(): void {
    this._resources = []
    this._isCut = false
    this._onDidChangeClipboard.fire()
  }
}

class FakeFileClipboard {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<IFileClipboardSnapshot>()
  readonly onDidChangeClipboard = this._emitter.event
  snapshot: IFileClipboardSnapshot = { resources: [], isCut: false, source: 'os' }
  readonly writeCalls: Array<{
    resources: readonly IFileClipboardResource[]
    isCut: boolean
  }> = []
  clearCalls = 0

  async readResources(): Promise<IFileClipboardSnapshot> {
    return this.snapshot
  }

  async writeResources(
    resources: readonly IFileClipboardResource[],
    isCut: boolean,
  ): Promise<void> {
    this.writeCalls.push({ resources, isCut })
  }

  async checkWriteCost() {
    return { materializeCount: 0, totalBytes: 0, needsConfirmation: false, refused: false }
  }

  async clear(): Promise<void> {
    this.clearCalls++
    this.snapshot = { resources: [], isCut: false, source: 'os' }
    this._emitter.fire(this.snapshot)
  }

  fire(snapshot: IFileClipboardSnapshot): void {
    this.snapshot = snapshot
    this._emitter.fire(snapshot)
  }
}

function setup(initial?: IFileClipboardSnapshot) {
  const services = new ServiceCollection()
  const contextKeys = new ContextKeyService()
  services.set(IContextKeyService, contextKeys)
  const tree = new FakeTree()
  services.set(IExplorerTreeService, tree as unknown as ExplorerTreeService)
  const fileClipboard = new FakeFileClipboard()
  if (initial) fileClipboard.snapshot = initial
  services.set(IFileClipboardService, fileClipboard as unknown as IFileClipboardService)
  const inst = new InstantiationService(services)
  const contrib = inst.createInstance(ExplorerClipboardContextContribution)
  return { contextKeys, tree, fileClipboard, contrib }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

const wsFile = URI.file('/ws/a.txt')

describe('ExplorerClipboardContextContribution', () => {
  const disposables: { dispose(): void }[] = []
  afterEach(() => {
    while (disposables.length) disposables.pop()!.dispose()
  })

  it('adopts the startup snapshot and seeds the context keys', async () => {
    const { contextKeys, tree, contrib } = setup({
      resources: [{ resource: wsFile.toJSON(), isDirectory: false }],
      isCut: true,
      source: 'internal',
    })
    disposables.push(contrib)
    await flush()
    expect(tree.adopted).toHaveLength(1)
    expect(tree.adopted[0]?.isCut).toBe(true)
    expect(tree.adopted[0]?.resources[0]?.resource.toString()).toBe(wsFile.toString())
    expect(contextKeys.get('fileCopied')).toBe(true)
    expect(contextKeys.get('explorerResourceCut')).toBe(true)
  })

  it('mirrors shared clipboard events into the tree and the context keys', () => {
    const { contextKeys, tree, fileClipboard, contrib } = setup()
    disposables.push(contrib)

    fileClipboard.fire({
      resources: [{ resource: wsFile.toJSON(), isDirectory: false }],
      isCut: false,
      source: 'internal',
    })
    expect(tree.adopted).toHaveLength(1)
    expect(tree.adopted[0]?.isCut).toBe(false)
    expect(contextKeys.get('fileCopied')).toBe(true)
    expect(contextKeys.get('explorerResourceCut')).toBe(false)

    fileClipboard.fire({ resources: [], isCut: false, source: 'os' })
    expect(contextKeys.get('fileCopied')).toBe(false)
    expect(contextKeys.get('explorerResourceCut')).toBe(false)
  })

  it('never writes back to the shared service from the adopt path', () => {
    const { tree, fileClipboard, contrib } = setup()
    disposables.push(contrib)

    fileClipboard.fire({
      resources: [{ resource: wsFile.toJSON(), isDirectory: false }],
      isCut: true,
      source: 'internal',
    })
    tree.clearClipboard()

    expect(fileClipboard.writeCalls).toHaveLength(0)
    expect(fileClipboard.clearCalls).toBe(0)
  })

  it('updates the context keys when the tree clears the clipboard internally', () => {
    const { contextKeys, tree, fileClipboard, contrib } = setup()
    disposables.push(contrib)

    fileClipboard.fire({
      resources: [{ resource: wsFile.toJSON(), isDirectory: false }],
      isCut: true,
      source: 'internal',
    })
    expect(contextKeys.get('explorerResourceCut')).toBe(true)

    // Internal path (e.g. delete hitting a cut item) clears the tree without
    // going through the shared service.
    tree.clearClipboard()
    expect(contextKeys.get('fileCopied')).toBe(false)
    expect(contextKeys.get('explorerResourceCut')).toBe(false)
  })

  it('ignores resources that fail to revive', () => {
    const { contextKeys, tree, fileClipboard, contrib } = setup()
    disposables.push(contrib)

    fileClipboard.fire({
      resources: [
        { resource: null as never, isDirectory: false },
        { resource: wsFile.toJSON(), isDirectory: false },
      ],
      isCut: false,
      source: 'internal',
    })
    expect(tree.adopted[0]?.resources).toHaveLength(1)
    expect(tree.adopted[0]?.resources[0]?.resource.toString()).toBe(wsFile.toString())
    expect(contextKeys.get('fileCopied')).toBe(true)
  })
})
