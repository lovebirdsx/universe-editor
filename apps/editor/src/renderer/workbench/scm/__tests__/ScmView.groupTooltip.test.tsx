/*---------------------------------------------------------------------------------------------
 *  The SCM group row's hover text. A group that carries a tooltip (a perforce
 *  changelist's whole multi-line description, too long for the one-line label)
 *  must show that instead of the label; groups without one fall back to it.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
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

function makeStorage(): IStorageServiceType {
  const data = new Map<string, unknown>()
  return {
    _serviceBrand: undefined,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined
    },
    async set(key: string, value: unknown) {
      data.set(key, value)
    },
    async remove(key: string) {
      data.delete(key)
    },
    onDidChangeWorkspaceScope: Event.None,
  }
}

function setup(): ScmService {
  const scm = new ScmService()
  const stubCommand: ICommandServiceType = {
    _serviceBrand: undefined,
    executeCommand: () => Promise.resolve(undefined),
  }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { activeEditor: undefined },
  } as unknown as IEditorGroupsServiceType)
  services.set(IStorageService, makeStorage())
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

beforeEach(() => _resetScmTreeStateForTests())
afterEach(() => {
  cleanup()
  _resetScmTreeStateForTests()
})

describe('ScmView — group row tooltip', () => {
  it('prefers the group tooltip, and falls back to the label without one', async () => {
    const scm = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'cl:7', '#7: first line')
      await scm.$updateGroup(1, { tooltip: '#7: first line\n\nsecond line' })
      await scm.$registerGroup(0, 2, 'cl:8', '#8: no description')
      await scm.$updateGroupResourceStates(2, [{ resourceUri: 'D:/repo/b.txt', contextValue: 'M' }])
    })

    const withTooltip = await screen.findByText('#7: first line')
    expect(withTooltip.getAttribute('data-tooltip')).toBe('#7: first line\n\nsecond line')

    const withoutTooltip = await screen.findByText('#8: no description')
    expect(withoutTooltip.getAttribute('data-tooltip')).toBe('#8: no description')
  })

  // The provider creates the group and only then assigns its description, so the
  // tooltip arrives one channel message after the row exists. The view must
  // re-read it rather than latch the label it rendered first.
  it('re-renders the row when the tooltip arrives after the group was registered', async () => {
    const scm = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'cl:7', '#7: first line')
      await scm.$updateGroupResourceStates(1, [{ resourceUri: 'D:/repo/a.txt', contextValue: 'M' }])
    })

    const label = await screen.findByText('#7: first line')
    expect(label.getAttribute('data-tooltip')).toBe('#7: first line')

    await act(async () => {
      await scm.$updateGroup(1, { tooltip: '#7: first line\n\nsecond line' })
    })
    expect(label.getAttribute('data-tooltip')).toBe('#7: first line\n\nsecond line')
  })
})
