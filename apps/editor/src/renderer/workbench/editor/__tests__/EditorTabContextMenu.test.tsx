/*---------------------------------------------------------------------------------------------
 *  Tests for EditorTabContextMenu — menu items come from MenuRegistry and
 *  clicking one dispatches the command with the right resource argument.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CommandsRegistry,
  MenuId,
  MenuRegistry,
  URI,
  type ICommandService,
} from '@universe-editor/platform'
import { EditorTabContextMenu } from '../EditorTabContextMenu.js'

class FakeCommand {
  readonly _serviceBrand = undefined
  readonly calls: Array<{ id: string; args: unknown[] }> = []
  registerCommand() {
    return { dispose() {} }
  }
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ id, args })
    return undefined
  }
}

afterEach(() => cleanup())

describe('EditorTabContextMenu', () => {
  it('renders items registered to MenuId.EditorTabContext', () => {
    const cmdId = 'test.menuItem.render'
    const cmdDisposable = CommandsRegistry.registerCommand(cmdId, () => {}, {
      description: '在资源管理器中显示',
    })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.EditorTabContext, {
      command: cmdId,
      group: 'reveal',
      order: 1,
    })
    try {
      const onClose = () => {}
      render(
        <EditorTabContextMenu
          state={{ x: 10, y: 20, resource: URI.file('/a.txt') }}
          commandService={new FakeCommand() as unknown as ICommandService}
          onClose={onClose}
        />,
      )
      expect(screen.getByText('在资源管理器中显示')).toBeTruthy()
    } finally {
      menuDisposable.dispose()
      cmdDisposable.dispose()
    }
  })

  it('clicking an item executes the command with the resource argument', () => {
    const cmdId = 'test.menuItem.execute'
    const cmdDisposable = CommandsRegistry.registerCommand(cmdId, () => {}, {
      description: 'Reveal in Explorer',
    })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.EditorTabContext, {
      command: cmdId,
      title: 'Reveal',
    })
    try {
      const cmd = new FakeCommand()
      let closed = 0
      const target = URI.file('/ws/src/main.ts')
      render(
        <EditorTabContextMenu
          state={{ x: 0, y: 0, resource: target }}
          commandService={cmd as unknown as ICommandService}
          onClose={() => closed++}
        />,
      )
      fireEvent.click(screen.getByText('Reveal'))
      expect(closed).toBe(1)
      expect(cmd.calls).toHaveLength(1)
      expect(cmd.calls[0]?.id).toBe(cmdId)
      const firstArg = cmd.calls[0]?.args?.[0] as { resource: { path: string } } | undefined
      expect(firstArg?.resource?.path).toBe(target.toJSON().path)
    } finally {
      menuDisposable.dispose()
      cmdDisposable.dispose()
    }
  })
})
