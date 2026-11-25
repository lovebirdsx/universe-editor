/*---------------------------------------------------------------------------------------------
 *  SCM resource rows render a provider-declared `decorations.iconPath` codicon
 *  in place of the file-type icon; an unknown id must fall back to the file
 *  icon instead of leaving a blank slot.
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

describe('ScmView — resource icon', () => {
  it('renders a declared codicon and falls back for an unknown id', async () => {
    const scm = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$registerGroup(0, 1, 'changes', 'Changes')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/a.txt', decorations: { iconPath: 'diff-modified' } },
        { resourceUri: 'D:/repo/b.txt', decorations: { iconPath: 'not-a-real-icon' } },
      ])
    })

    const decorated = (await screen.findByText('a.txt')).closest('[role="treeitem"]') as HTMLElement
    expect(decorated.querySelector('.codicon-diff-modified')).not.toBeNull()
    expect(decorated.querySelector('[data-file-icon]')).toBeNull()

    const fallback = (await screen.findByText('b.txt')).closest('[role="treeitem"]') as HTMLElement
    expect(fallback.querySelector('.codicon-not-a-real-icon')).toBeNull()
    expect(fallback.querySelector('[data-file-icon]')).not.toBeNull()
  })
})
