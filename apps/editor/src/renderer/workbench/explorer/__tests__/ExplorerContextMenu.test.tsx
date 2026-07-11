/*---------------------------------------------------------------------------------------------
 *  Tests for ExplorerContextMenu — Explorer context actions need a richer arg
 *  payload than the generic ContextMenu provides, so this wrapper normalizes
 *  the clicked resource into target/resource/parent/isDirectory.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CommandsRegistry,
  ContextKeyService,
  ICommandService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  observableValue,
} from '@universe-editor/platform'
import type { ExplorerTreeService } from '../../../services/explorer/ExplorerTreeService.js'
import {
  IScmService,
  type IScmSourceControlModel,
} from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'
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

/** Minimal IScmSourceControlModel: provider gating only reads id + rootUri. */
function scmModel(id: string, rootUri: string): IScmSourceControlModel {
  return {
    handle: 0,
    id,
    label: id,
    rootUri,
    inputValue: observableValue('v', ''),
    inputPlaceholder: observableValue('p', ''),
    count: observableValue<number | undefined>('c', undefined),
    acceptCommand: observableValue('ac', undefined),
    acceptActions: observableValue('aa', undefined),
    groups: observableValue('g', []),
  }
}

/** Render `node` inside a DI container exposing an IScmService with `controls`. */
function renderWithScm(
  controls: readonly IScmSourceControlModel[],
  node: ReactElement,
): ReturnType<typeof render> {
  const scmService = {
    _serviceBrand: undefined,
    sourceControls: observableValue('scm', controls),
  } as unknown as IScmService
  const services = new ServiceCollection()
  services.set(IScmService, scmService as never)
  const instantiation = new InstantiationService(services)
  return render(<ServicesContext.Provider value={instantiation}>{node}</ServicesContext.Provider>)
}

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

  it('exposes resourceScheme so file-gated items (e.g. Perforce) show for file targets', () => {
    const cmdId = 'test.explorer.p4edit'
    const cmdDisposable = CommandsRegistry.registerCommand(cmdId, () => {}, {
      description: 'Open for Edit',
    })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
      command: cmdId,
      title: 'Open for Edit',
      when: 'resourceScheme == file && !explorerResourceIsFolder',
    })
    const contextKeyService = new ContextKeyService()

    try {
      const commandService = new FakeCommandService()
      const root = URI.file('/ws')
      const file = URI.joinPath(root, 'main.ts')

      render(
        <ExplorerContextMenu
          state={{ x: 0, y: 0, target: { resource: file, isDirectory: false } }}
          rootResource={root}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={contextKeyService}
          onClose={() => {}}
        />,
      )
      expect(screen.getByText('Open for Edit')).toBeDefined()
    } finally {
      contextKeyService.dispose()
      menuDisposable.dispose()
      cmdDisposable.dispose()
    }
  })

  it('gates provider-specific items on resourceScmProvider (shown when the file is owned)', () => {
    const cmdId = 'perforce.edit'
    const cmdDisposable = CommandsRegistry.registerCommand(cmdId, () => {}, {
      description: 'Open for Edit (Perforce)',
    })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
      command: cmdId,
      title: 'Open for Edit (Perforce)',
      when: 'resourceScmProvider =~ /\\|perforce\\|/ && !explorerResourceIsFolder',
    })
    const contextKeyService = new ContextKeyService()

    try {
      const commandService = new FakeCommandService()
      const root = URI.file('/ws')
      const file = URI.joinPath(root, 'main.ts')

      // A perforce provider whose root contains the file → item visible.
      const owned = renderWithScm(
        [scmModel('perforce', root.fsPath)],
        <ExplorerContextMenu
          state={{ x: 0, y: 0, target: { resource: file, isDirectory: false } }}
          rootResource={root}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={contextKeyService}
          onClose={() => {}}
        />,
      )
      expect(screen.getByText('Open for Edit (Perforce)')).toBeDefined()
      owned.unmount()

      // Only a git provider present → the file is not perforce-owned → hidden.
      renderWithScm(
        [scmModel('git', root.fsPath)],
        <ExplorerContextMenu
          state={{ x: 0, y: 0, target: { resource: file, isDirectory: false } }}
          rootResource={root}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={contextKeyService}
          onClose={() => {}}
        />,
      )
      expect(screen.queryByText('Open for Edit (Perforce)')).toBeNull()
    } finally {
      contextKeyService.dispose()
      menuDisposable.dispose()
      cmdDisposable.dispose()
    }
  })

  it('shows Perforce items for a file in a git repo nested inside a Perforce workspace', () => {
    const cmdId = 'perforce.edit'
    const cmdDisposable = CommandsRegistry.registerCommand(cmdId, () => {}, {
      description: 'Open for Edit (Perforce)',
    })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
      command: cmdId,
      title: 'Open for Edit (Perforce)',
      when: 'resourceScmProvider =~ /\\|perforce\\|/ && !explorerResourceIsFolder',
    })
    const contextKeyService = new ContextKeyService()

    try {
      const commandService = new FakeCommandService()
      // Perforce workspace at the top, a git repo nested below it — the file is
      // owned by both. The git root is the longer (more specific) prefix, which
      // must NOT hide the outer Perforce actions.
      const p4Root = URI.file('/depot/Client')
      const gitRoot = URI.joinPath(p4Root, 'Src', 'UniverseEditor')
      const file = URI.joinPath(gitRoot, 'main.ts')

      renderWithScm(
        [scmModel('perforce', p4Root.fsPath), scmModel('git', gitRoot.fsPath)],
        <ExplorerContextMenu
          state={{ x: 0, y: 0, target: { resource: file, isDirectory: false } }}
          rootResource={p4Root}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={contextKeyService}
          onClose={() => {}}
        />,
      )
      expect(screen.getByText('Open for Edit (Perforce)')).toBeDefined()
    } finally {
      contextKeyService.dispose()
      menuDisposable.dispose()
      cmdDisposable.dispose()
    }
  })
})
