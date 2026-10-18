/*---------------------------------------------------------------------------------------------
 *  Tests for ExplorerSelectionContextContribution — the root-level
 *  `explorerMultiSelection` key that gates Escape's cancel-selection binding.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  IContextKeyService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { ExplorerSelectionContextContribution } from '../ExplorerSelectionContextContribution.js'
import { IExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'
import type { ExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'

class FakeTree {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChangeSelection = new Emitter<void>()
  readonly onDidChangeSelection = this._onDidChangeSelection.event
  selection: readonly unknown[] = []

  get selectionCount(): number {
    return this.selection.length
  }

  setSelection(count: number): void {
    this.selection = Array.from({ length: count })
    this._onDidChangeSelection.fire()
  }
}

function setup() {
  const services = new ServiceCollection()
  const contextKeys = new ContextKeyService()
  services.set(IContextKeyService, contextKeys)
  const tree = new FakeTree()
  services.set(IExplorerTreeService, tree as unknown as ExplorerTreeService)
  const inst = new InstantiationService(services)
  return { contextKeys, tree, contrib: inst.createInstance(ExplorerSelectionContextContribution) }
}

const disposables: { dispose(): void }[] = []
afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

describe('ExplorerSelectionContextContribution', () => {
  it('mirrors whether more than one row is selected', () => {
    const { contextKeys, tree, contrib } = setup()
    disposables.push(contrib)
    expect(contextKeys.get('explorerMultiSelection')).toBe(false)

    tree.setSelection(2)
    expect(contextKeys.get('explorerMultiSelection')).toBe(true)

    tree.setSelection(1)
    expect(contextKeys.get('explorerMultiSelection')).toBe(false)
  })
})
