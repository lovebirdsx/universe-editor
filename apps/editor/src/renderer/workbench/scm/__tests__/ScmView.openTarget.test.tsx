/*---------------------------------------------------------------------------------------------
 *  Ctrl/Meta/Alt+Enter on an SCM resource row forwards the open target to the
 *  provider's open command as a trailing options object.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IEditorGroupsService,
  IEditorResolverService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  type ICommandService as ICommandServiceType,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IEditorResolverService as IEditorResolverServiceType,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import { ScmView } from '../ScmView.js'
import { _resetScmTreeStateForTests } from '../scmTreeState.js'
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'

const ROOT = 'D:/repo'
const FILE = `${ROOT}/a.txt`

const stubStorage: IStorageServiceType = {
  _serviceBrand: undefined,
  async get() {
    return undefined
  },
  async set() {},
  async remove() {},
  onDidChangeWorkspaceScope: Event.None,
}

function setup(executeCommand: ReturnType<typeof vi.fn>) {
  const scm = new ScmService()
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
  } as unknown as ICommandServiceType)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { activeEditor: undefined },
  } as unknown as IEditorGroupsServiceType)
  services.set(IStorageService, stubStorage)
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: () => [],
    openEditor: () => Promise.resolve(undefined),
  } as unknown as IEditorResolverServiceType)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ScmView />
    </ServicesContext.Provider>,
  )
  return scm
}

async function seedFile(scm: ScmService): Promise<void> {
  await act(async () => {
    await scm.$registerSourceControl(0, 'git', 'Git', ROOT)
    await scm.$registerGroup(0, 1, 'changes', 'Changes')
    await scm.$updateGroupResourceStates(1, [
      {
        resourceUri: FILE,
        contextValue: 'M',
        command: {
          command: 'git.openChange',
          title: 'Open Changes',
          arguments: [{ resourceUri: FILE }],
        },
      },
    ])
  })
}

function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('[role="treeitem"]') as HTMLElement
}

beforeEach(() => _resetScmTreeStateForTests())
afterEach(() => {
  cleanup()
  _resetScmTreeStateForTests()
})

describe('ScmView — targeted opens', () => {
  async function focusRow(): Promise<ReturnType<typeof vi.fn>> {
    const executeCommand = vi.fn().mockResolvedValue(undefined)
    const scm = setup(executeCommand)
    await seedFile(scm)
    await screen.findByText('a.txt')
    fireEvent.click(rowFor('a.txt'))
    // The click already opened the row's default diff; only the keyboard
    // activation is under test.
    executeCommand.mockClear()
    return executeCommand
  }

  it('Ctrl+Enter passes the side target to the provider command', async () => {
    const executeCommand = await focusRow()

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter', ctrlKey: true })

    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith(
      'git.openChange',
      { resourceUri: FILE },
      { pinned: true, openTarget: 'side' },
    )
  })

  it('Alt+Enter passes the new-window target', async () => {
    const executeCommand = await focusRow()

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter', altKey: true })

    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith(
      'git.openChange',
      { resourceUri: FILE },
      { pinned: true, openTarget: 'newWindow' },
    )
  })

  it('plain Enter keeps the original argument list', async () => {
    const executeCommand = await focusRow()

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter' })

    expect(executeCommand).toHaveBeenCalledWith('git.openChange', { resourceUri: FILE })
  })
})
