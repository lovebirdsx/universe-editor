/*---------------------------------------------------------------------------------------------
 *  Regression: the SCM title-bar menu (Pull / Push / Commit / Changes …) must
 *  target the repo the view currently shows, not the first one. All git repos
 *  share the SourceControl id `git`, so memoizing the menu rows / runCommand
 *  closure on `selected.id` left them stale after a repo switch — every menu
 *  command kept firing against the main repo's rootUri. The deps key on rootUri.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  ICommandService,
  MenuId,
  MenuRegistry,
  type ICommandService as ICommandServiceType,
  type IDisposable,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { ScmViewToolbar } from '../ScmViewToolbar.js'
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'
import { scmViewState } from '../scmViewState.js'

const REPO_A = 'D:/repo'
const REPO_B = 'D:/repo/sub'

function setup() {
  const scm = new ScmService()
  const executeCommand = vi.fn().mockResolvedValue(undefined)
  const stubCommand: ICommandServiceType = { _serviceBrand: undefined, executeCommand }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ScmViewToolbar />
    </ServicesContext.Provider>,
  )
  return { scm, executeCommand }
}

describe('ScmViewToolbar — menu targets the selected repo', () => {
  let menuItem: IDisposable

  beforeAll(() => {
    menuItem = MenuRegistry.addMenuItem(MenuId.ScmTitle, {
      command: 'git.push',
      title: 'Push',
      group: 'navigation',
    })
  })
  afterAll(() => menuItem.dispose())
  afterEach(() => scmViewState.setSelectedRepo(undefined))

  it('fires the navigation command against the newly selected repo', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', REPO_A)
      await scm.$registerSourceControl(1, 'git', 'Git: sub', REPO_B)
    })

    // Default selection is the first repo.
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    expect(executeCommand).toHaveBeenLastCalledWith('git.push', {
      rootUri: REPO_A,
      sourceControlId: 'git',
    })

    // Switch the view to the submodule; the same nav button must now target it.
    await act(async () => {
      scmViewState.setSelectedRepo(REPO_B)
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    expect(executeCommand).toHaveBeenLastCalledWith('git.push', {
      rootUri: REPO_B,
      sourceControlId: 'git',
    })
  })
})
