/*---------------------------------------------------------------------------------------------
 *  Tests for ScmSelectedRepoContribution — the SCM view's selected repo is
 *  persisted per workspace, but the restore must NOT depend on the ScmView
 *  component mounting: dirty-diff/blame arbitration consumes the selection even
 *  when the user never opens the SCM panel (closing the workspace with the panel
 *  hidden used to leave arbitration on the longest-prefix fallback, e.g. git
 *  blame showing for a p4-selected workspace until the panel got focus).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { IStorageService, InstantiationService, ServiceCollection } from '@universe-editor/platform'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import { ScmSelectedRepoContribution } from '../ScmSelectedRepoContribution.js'

function setup(stored?: string) {
  const store = new Map<string, unknown>()
  if (stored !== undefined) store.set('scm.selectedRepo', stored)
  const storage = {
    _serviceBrand: undefined,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value)
    },
  } as unknown as IStorageService

  const services = new ServiceCollection()
  services.set(IStorageService, storage)
  const inst = new InstantiationService(services)
  return { inst, store }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('ScmSelectedRepoContribution', () => {
  afterEach(() => {
    scmViewState.setSelectedRepo(undefined)
  })

  it('hydrates the persisted selection without any view mounting', async () => {
    const { inst } = setup('/ws')
    inst.createInstance(ScmSelectedRepoContribution)
    await flushMicrotasks()
    expect(scmViewState.selectedRepo.get()).toBe('/ws')
  })

  it('does not clobber an in-memory selection made before hydration landed', async () => {
    const { inst } = setup('/ws')
    scmViewState.setSelectedRepo('/other')
    inst.createInstance(ScmSelectedRepoContribution)
    await flushMicrotasks()
    expect(scmViewState.selectedRepo.get()).toBe('/other')
  })

  it('persists later selection changes back to workspace storage', async () => {
    const { inst, store } = setup()
    inst.createInstance(ScmSelectedRepoContribution)
    await flushMicrotasks()

    scmViewState.setSelectedRepo('/ws/p4')
    await flushMicrotasks()
    expect(store.get('scm.selectedRepo')).toBe('/ws/p4')
  })

  it('never writes before hydration completes, then persists the current value', async () => {
    const { inst, store } = setup('/ws')
    inst.createInstance(ScmSelectedRepoContribution)
    // A change racing the in-flight hydrate: nothing is written yet (the write
    // back autorun only registers once hydration settles), and the in-memory
    // choice wins over the stale stored value.
    scmViewState.setSelectedRepo('/other')
    expect(store.get('scm.selectedRepo')).toBe('/ws')
    await flushMicrotasks()
    expect(scmViewState.selectedRepo.get()).toBe('/other')
    expect(store.get('scm.selectedRepo')).toBe('/other')
  })
})
