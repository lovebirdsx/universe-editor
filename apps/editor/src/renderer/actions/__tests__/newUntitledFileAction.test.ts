/*---------------------------------------------------------------------------------------------
 *  Tests for NewUntitledFileAction + Save→SaveAs delegation (主题 11 WP3).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ICommandService,
  IEditorGroupsService,
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  registerAction2,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupsService as IEditorGroupsServiceType,
} from '@universe-editor/platform'
import { NewUntitledFileAction } from '../newUntitledFileAction.js'
import { SaveFileAction, SaveFileAsAction } from '../fileActions.js'
import { UntitledEditorInput } from '../../workbench/editor/UntitledEditorInput.js'

interface FakeGroup extends IEditorGroup {
  readonly opened: EditorInput[]
}

function makeGroup(activeEditor?: EditorInput) {
  const opened: EditorInput[] = []
  const group = {
    activeEditor,
    opened,
    openEditor(e: EditorInput) {
      opened.push(e)
    },
    closeEditor() {
      return true
    },
  } as unknown as FakeGroup
  const service = { activeGroup: group } as unknown as IEditorGroupsServiceType
  return { group, service }
}

class FakeCommandService {
  declare readonly _serviceBrand: undefined
  readonly calls: Array<{ id: string; args: unknown[] }> = []
  registerCommand() {
    return { dispose() {} }
  }
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ id, args })
    return undefined
  }
}

function makeHarness(activeEditor?: EditorInput) {
  const { group, service: groupsService } = makeGroup(activeEditor)
  const commandService = new FakeCommandService()
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groupsService)
  services.set(ICommandService, commandService as unknown as ICommandService)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst as unknown as IInstantiationService)
  return { inst, group, commandService }
}

function run(inst: InstantiationService, id: string, args?: unknown): Promise<unknown> {
  const cmd = CommandsRegistry.getCommand(id)
  if (!cmd) throw new Error(`Command ${id} not registered`)
  return inst.invokeFunction((accessor) => cmd.handler(accessor, args)) as Promise<unknown>
}

const disposables: Array<{ dispose(): void }> = []
beforeEach(() => {
  disposables.push(registerAction2(NewUntitledFileAction))
  disposables.push(registerAction2(SaveFileAction))
  disposables.push(registerAction2(SaveFileAsAction))
})
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

describe('NewUntitledFileAction', () => {
  it('opens a fresh untitled input in the active group', async () => {
    const h = makeHarness()
    await run(h.inst, NewUntitledFileAction.ID)
    expect(h.group.opened).toHaveLength(1)
    expect(h.group.opened[0]).toBeInstanceOf(UntitledEditorInput)
    expect(h.group.opened[0]?.typeId).toBe('untitled')
  })
})

describe('SaveFileAction with untitled active editor', () => {
  it('delegates to SaveFileAsAction via the command service', async () => {
    const untitled = new UntitledEditorInput()
    const h = makeHarness(untitled)
    await run(h.inst, SaveFileAction.ID)
    expect(h.commandService.calls.map((c) => c.id)).toContain(SaveFileAsAction.ID)
  })
})
