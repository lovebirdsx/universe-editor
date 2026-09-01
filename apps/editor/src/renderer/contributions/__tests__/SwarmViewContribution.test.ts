/*---------------------------------------------------------------------------------------------
 *  The Swarm Reviews container must track Perforce workspace availability:
 *  registered while a perforce source control exists, deregistered otherwise —
 *  so non-Perforce workspaces never see the entry point at all.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  observableValue,
  ViewContainerRegistry,
  ViewRegistry,
  type IConfigurationService,
  type IObservable,
  type IStorageService,
} from '@universe-editor/platform'
import type { IScmService, IScmSourceControlModel } from '../../services/extensions/ScmService.js'
import { SwarmViewContribution } from '../SwarmViewContribution.js'

function makeScm(initial: readonly IScmSourceControlModel[]): {
  service: IScmService
  sourceControls: IObservable<readonly IScmSourceControlModel[]>
  set: (controls: readonly IScmSourceControlModel[]) => void
} {
  const sourceControls = observableValue<readonly IScmSourceControlModel[]>(
    'sourceControls',
    initial,
  )
  const service: IScmService = {
    _serviceBrand: undefined,
    sourceControls,
    onDidPublishWorkingTreeScan: () => ({ dispose() {} }),
    changeInputBoxValue() {},
    setExtHost() {},
    resetSourceControls() {},
  }
  return { service, sourceControls, set: (controls) => sourceControls.set(controls, undefined) }
}

const perforceControl = { id: 'perforce' } as unknown as IScmSourceControlModel

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function makeConfiguration(): IConfigurationService {
  return {
    _serviceBrand: undefined,
    get: () => 0,
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  } as unknown as IConfigurationService
}

describe('SwarmViewContribution', () => {
  const contributions: SwarmViewContribution[] = []

  afterEach(() => {
    for (const c of contributions.splice(0)) c.dispose()
  })

  function create(initial: readonly IScmSourceControlModel[]) {
    const scm = makeScm(initial)
    const contribution = new SwarmViewContribution(makeStorage(), makeConfiguration(), scm.service)
    contributions.push(contribution)
    return scm
  }

  it('stays unregistered without a perforce source control', () => {
    create([])
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeUndefined()
    expect(ViewRegistry.getView('workbench.view.swarm.reviews')).toBeUndefined()
  })

  it('registers while a perforce source control exists and deregisters when it disappears', () => {
    const scm = create([])
    scm.set([perforceControl])
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeDefined()
    expect(ViewRegistry.getView('workbench.view.swarm.reviews')).toBeDefined()

    scm.set([])
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeUndefined()
    expect(ViewRegistry.getView('workbench.view.swarm.reviews')).toBeUndefined()
  })

  it('registers immediately when constructed with a perforce source control', () => {
    create([perforceControl])
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeDefined()
  })

  it('does not churn registrations on unrelated source control changes', () => {
    const scm = create([perforceControl])
    const registered = ViewContainerRegistry.getViewContainer('workbench.view.swarm')
    scm.set([perforceControl, { id: 'git' } as unknown as IScmSourceControlModel])
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBe(registered)
  })

  it('deregisters on dispose', () => {
    const contribution = (() => {
      const scm = makeScm([perforceControl])
      return new SwarmViewContribution(makeStorage(), makeConfiguration(), scm.service)
    })()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeDefined()
    contribution.dispose()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeUndefined()
  })
})
