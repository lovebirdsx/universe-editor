/*---------------------------------------------------------------------------------------------
 *  Tests for EditorContextMenu — seeds a scoped ContextKeyService from the
 *  clicked editor and passes the document URI as the first command arg.
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
import type { monaco } from '../monaco/MonacoLoader.js'
import { EditorContextMenu } from '../EditorContextMenu.js'

class FakeCommandService {
  readonly _serviceBrand = undefined
  readonly calls: Array<{ id: string; args: unknown[] }> = []

  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ id, args })
    return undefined
  }
}

function fakeEditor(overrides: { selectionEmpty?: boolean; langId?: string } = {}) {
  const selection = { isEmpty: () => overrides.selectionEmpty ?? false }
  const editor = {
    getSelection: () => selection,
    getModel: () => ({ getLanguageId: () => overrides.langId ?? 'plaintext' }),
  }
  return editor as unknown as monaco.editor.IStandaloneCodeEditor
}

afterEach(() => cleanup())

describe('EditorContextMenu', () => {
  it('passes the document URI as the first arg and executes on click', () => {
    const cmdId = 'test.editorContext.action'
    const cmd = CommandsRegistry.registerCommand(cmdId, () => {}, { description: 'Do It' })
    const menu = MenuRegistry.addMenuItem(MenuId.EditorContext, {
      command: cmdId,
      title: 'Do It',
    })

    try {
      const commandService = new FakeCommandService()
      const resource = URI.file('/ws/src/main.ts')

      render(
        <EditorContextMenu
          x={10}
          y={20}
          resource={resource}
          editor={fakeEditor()}
          isReadonly={false}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={new ContextKeyService()}
          onClose={() => {}}
        />,
      )

      fireEvent.click(screen.getByText('Do It'))

      expect(commandService.calls).toHaveLength(1)
      expect(commandService.calls[0]?.id).toBe(cmdId)
      expect(commandService.calls[0]?.args).toHaveLength(1)
      expect((commandService.calls[0]?.args[0] as URI).toString()).toBe(resource.toString())
    } finally {
      menu.dispose()
      cmd.dispose()
    }
  })

  it('seeds editorHasSelection so selection-gated items show only with a selection', () => {
    const cmdId = 'test.editorContext.hasSelection'
    const cmd = CommandsRegistry.registerCommand(cmdId, () => {}, { description: 'With Sel' })
    const menu = MenuRegistry.addMenuItem(MenuId.EditorContext, {
      command: cmdId,
      title: 'With Sel',
      when: 'editorHasSelection',
    })
    const contextKeyService = new ContextKeyService()

    try {
      const commandService = new FakeCommandService()
      const resource = URI.file('/ws/src/main.ts')

      const { unmount } = render(
        <EditorContextMenu
          x={0}
          y={0}
          resource={resource}
          editor={fakeEditor({ selectionEmpty: true })}
          isReadonly={false}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={contextKeyService}
          onClose={() => {}}
        />,
      )
      expect(screen.queryByText('With Sel')).toBeNull()
      unmount()

      render(
        <EditorContextMenu
          x={0}
          y={0}
          resource={resource}
          editor={fakeEditor({ selectionEmpty: false })}
          isReadonly={false}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={contextKeyService}
          onClose={() => {}}
        />,
      )
      expect(screen.getByText('With Sel')).toBeDefined()
    } finally {
      contextKeyService.dispose()
      menu.dispose()
      cmd.dispose()
    }
  })

  it('seeds editorReadonly, resourceScheme, resourceExtname and editorLangId', () => {
    const readonlyCmd = 'test.editorContext.readonly'
    const readonly = CommandsRegistry.registerCommand(readonlyCmd, () => {}, {
      description: 'Readonly Only',
    })
    const readonlyMenu = MenuRegistry.addMenuItem(MenuId.EditorContext, {
      command: readonlyCmd,
      title: 'Readonly Only',
      when: 'editorReadonly && resourceScheme == file && resourceExtname == .ts && editorLangId == typescript',
    })
    const contextKeyService = new ContextKeyService()

    try {
      const commandService = new FakeCommandService()
      const resource = URI.file('/ws/src/main.ts')

      render(
        <EditorContextMenu
          x={0}
          y={0}
          resource={resource}
          editor={fakeEditor({ langId: 'typescript' })}
          isReadonly={true}
          commandService={commandService as unknown as ICommandService}
          contextKeyService={contextKeyService}
          onClose={() => {}}
        />,
      )
      expect(screen.getByText('Readonly Only')).toBeDefined()
    } finally {
      contextKeyService.dispose()
      readonlyMenu.dispose()
      readonly.dispose()
    }
  })
})
