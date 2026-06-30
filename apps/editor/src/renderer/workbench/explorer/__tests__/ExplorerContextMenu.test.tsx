/*---------------------------------------------------------------------------------------------
 *  Tests for ExplorerContextMenu — Explorer context actions need a richer arg
 *  payload than the generic ContextMenu provides, so this wrapper normalizes
 *  the clicked resource into target/resource/parent/isDirectory.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CommandsRegistry,
  ContextKeyService,
  MenuId,
  MenuRegistry,
  URI,
  type ICommandService,
} from '@universe-editor/platform'
import type { ExplorerTreeService } from '../../../services/explorer/ExplorerTreeService.js'
import { ExplorerContextMenu } from '../ExplorerContextMenu.js'

class FakeCommandService {
  readonly _serviceBrand = undefined
  readonly calls: Array<{ id: string; args: unknown[] }> = []

  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ id, args })
    return undefined
  }
}

afterEach(() => cleanup())

describe('ExplorerContextMenu', () => {
  it('clicking a menu item passes target/resource/parent args for a file target', () => {
    const cmdId = 'test.explorer.delete'
    const cmdDisposable = CommandsRegistry.registerCommand(cmdId, () => {}, {
      description: 'Delete',
    })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
      command: cmdId,
      title: 'Delete',
    })

    try {
      const commandService = new FakeCommandService()
      const root = URI.file('/ws')
      const target = URI.joinPath(root, 'src', 'main.ts')

      render(
        <ExplorerContextMenu
          state={{ x: 0, y: 0, target: { resource: target, isDirectory: false } }}
          rootResource={root}
          commandService={commandService as unknown as ICommandService}
          onClose={() => {}}
        />,
      )

      fireEvent.click(screen.getByText('Delete'))

      expect(commandService.calls).toHaveLength(1)
      expect(commandService.calls[0]?.id).toBe(cmdId)
      const arg = commandService.calls[0]?.args[0] as
        | {
            target: { path: string }
            resource: { path: string }
            parent: { path: string }
            isDirectory: boolean
          }
        | undefined
      expect(arg?.target.path).toBe(target.toJSON().path)
      expect(arg?.resource.path).toBe(target.toJSON().path)
      expect(arg?.parent.path).toBe(URI.joinPath(root, 'src').toJSON().path)
      expect(arg?.isDirectory).toBe(false)
    } finally {
      menuDisposable.dispose()
      cmdDisposable.dispose()
    }
  })

  it('filters menu items with scoped Explorer resource and clipboard context', () => {
    const cmdId = 'test.explorer.paste'
    const cmdDisposable = CommandsRegistry.registerCommand(cmdId, () => {}, {
      description: 'Paste',
    })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
      command: cmdId,
      title: 'Paste',
      when: 'fileCopied && explorerResourceIsFolder',
    })
    const contextKeyService = new ContextKeyService()

    try {
      const commandService = new FakeCommandService()
      const root = URI.file('/ws')
      const file = URI.joinPath(root, 'main.ts')
      const folder = URI.joinPath(root, 'src')
      const tree = {
        hasClipboard: true,
        hasCutItems: false,
        isRoot: (resource: URI) => resource.toString() === root.toString(),
      } as unknown as ExplorerTreeService

      const { unmount } = render(
        <ExplorerContextMenu
          state={{ x: 0, y: 0, target: { resource: file, isDirectory: false } }}
          rootResource={root}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={contextKeyService}
          tree={tree}
          onClose={() => {}}
        />,
      )
      expect(screen.queryByText('Paste')).toBeNull()
      unmount()

      render(
        <ExplorerContextMenu
          state={{ x: 0, y: 0, target: { resource: folder, isDirectory: true } }}
          rootResource={root}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={contextKeyService}
          tree={tree}
          onClose={() => {}}
        />,
      )
      expect(screen.getByText('Paste')).toBeDefined()
    } finally {
      contextKeyService.dispose()
      menuDisposable.dispose()
      cmdDisposable.dispose()
    }
  })
})
