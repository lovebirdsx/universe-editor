/*---------------------------------------------------------------------------------------------
 *  Regression: under React StrictMode the SCM view must still show resources that
 *  arrive after the provider view has mounted. A TreeModel owned by a plain
 *  useMemo+dispose effect gets disposed by StrictMode's mount→unmount→mount dry
 *  run, leaving a dead model whose structure events never reach <Tree> — so the
 *  list/tree stayed permanently empty.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IEditorResolverService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  type ICommandService as ICommandServiceType,
  type IEditorResolverService as IEditorResolverServiceType,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import { ScmView } from '../ScmView.js'
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'

const stubStorage: IStorageServiceType = {
  _serviceBrand: undefined,
  async get() {
    return undefined
  },
  async set() {},
  async remove() {},
  onDidChangeWorkspaceScope: Event.None,
}

const stubEditorResolver: IEditorResolverServiceType = {
  _serviceBrand: undefined,
  registerEditor: () => ({ dispose() {} }),
  resolveEditors: () => [],
  async openEditor() {},
}

function setup() {
  const scm = new ScmService()
  const executeCommand = vi.fn().mockResolvedValue(undefined)
  const stubCommand: ICommandServiceType = {
    _serviceBrand: undefined,
    executeCommand,
  }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  services.set(IStorageService, stubStorage)
  services.set(IEditorResolverService, stubEditorResolver)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <StrictMode>
        <ScmView />
      </StrictMode>
    </ServicesContext.Provider>,
  )
  return { scm, executeCommand }
}

describe('ScmView under StrictMode', () => {
  it('renders resources that arrive after the provider view has mounted', async () => {
    const { scm } = setup()

    // 1. The provider view mounts with an empty group — this is when its
    //    TreeModel goes through StrictMode's mount→unmount→mount cycle.
    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$registerGroup(0, 1, 'changes', 'Changes')
    })

    // 2. Resources arrive later (the git scan finishes), driving the model via
    //    the snapshot rebuild + refresh path.
    await act(async () => {
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/foo.txt', contextValue: 'M' },
      ])
    })

    expect(await screen.findByText('foo.txt')).toBeTruthy()
  })

  it('disables Commit when git has no local changes and nothing to synchronize', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.commit', title: 'Commit', disabled: true },
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
    })

    const button = (await screen.findByRole('button', { name: 'Commit' })) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('shows Pull Rebase when git has no local changes and local plus remote commits exist', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.pullRebase', title: 'Pull Rebase' },
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
    })

    const button = (await screen.findByRole('button', { name: 'Pull Rebase' })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(executeCommand).toHaveBeenCalledWith('git.pullRebase', {
      rootUri: 'D:/repo',
      sourceControlId: 'git',
    })
  })

  it('shows Push when git has no local changes and only local commits exist', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.push', title: 'Push' },
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
    })

    const button = (await screen.findByRole('button', { name: 'Push' })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(executeCommand).toHaveBeenCalledWith('git.push', {
      rootUri: 'D:/repo',
      sourceControlId: 'git',
    })
  })

  it('shows Pull when git has no local changes and only remote commits exist', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.pull', title: 'Pull' },
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
    })

    const button = (await screen.findByRole('button', { name: 'Pull' })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(executeCommand).toHaveBeenCalledWith('git.pull', {
      rootUri: 'D:/repo',
      sourceControlId: 'git',
    })
  })

  it('keeps Commit enabled when git has local changes', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.sync', title: 'Sync' },
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/foo.txt', contextValue: 'M' },
      ])
    })

    const button = (await screen.findByRole('button', { name: 'Commit' })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(executeCommand).toHaveBeenCalledWith('git.commit', {
      rootUri: 'D:/repo',
      sourceControlId: 'git',
    })
  })
})
