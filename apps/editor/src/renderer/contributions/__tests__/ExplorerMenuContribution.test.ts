/*---------------------------------------------------------------------------------------------
 *  Tests for ExplorerMenuContribution's "5_open" group. The preview entry is the
 *  one item there whose visibility is not derivable from the command alone: it
 *  gates on `explorerResourceIsPreviewable`, a key ExplorerContextMenu seeds in
 *  its row scope. Registering the real contribution and filtering by scope (as
 *  EditorContextMenuContribution.test.ts does) is what pins command id, group,
 *  order and when-clause together, so a rename or a reorder cannot slip through.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  MenuId,
  MenuRegistry,
  type IDisposable,
  type IMenuItem,
} from '@universe-editor/platform'
import { ExplorerMenuContribution } from '../ExplorerMenuContribution.js'

const disposables: IDisposable[] = []

function openGroupItems(overrides: Record<string, unknown>): IMenuItem[] {
  const ctx = new ContextKeyService().createScoped({ resourceScheme: 'file', ...overrides })
  disposables.push(ctx)
  return MenuRegistry.getMenuItems(MenuId.ExplorerContext, ctx).filter(
    (e): e is IMenuItem => 'command' in e && e.group === '5_open',
  )
}

afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

describe('ExplorerMenuContribution', () => {
  it('leads the open group with Open Preview for previewable files', () => {
    disposables.push(new ExplorerMenuContribution())

    const items = openGroupItems({ explorerResourceIsPreviewable: true })

    expect(items.map((e) => e.command)).toEqual([
      'workbench.files.action.openPreview',
      'workbench.files.action.openWithDefaultApp',
      'workbench.files.action.revealInOsExplorer',
    ])
    expect(items.map((e) => e.order)).toEqual([1, 2, 3])
    expect(items[0]?.icon).toBe('open-preview')
  })

  it('hides Open Preview for files with no preview flavor', () => {
    disposables.push(new ExplorerMenuContribution())

    const commands = openGroupItems({ explorerResourceIsPreviewable: false }).map((e) => e.command)

    expect(commands).toEqual([
      'workbench.files.action.openWithDefaultApp',
      'workbench.files.action.revealInOsExplorer',
    ])
  })

  // The key is seeded per row, so a scope without it (every context outside the
  // Explorer menu) must not surface the entry.
  it('hides Open Preview when the row scope never set the key', () => {
    disposables.push(new ExplorerMenuContribution())

    const commands = openGroupItems({}).map((e) => e.command)

    expect(commands).not.toContain('workbench.files.action.openPreview')
  })
})
