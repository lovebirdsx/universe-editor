/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/contribution/contribution.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Disposable } from '../../base/lifecycle.js'
import {
  ContributionsRegistry,
  ContributionService,
  WorkbenchPhase,
} from '../../contribution/contribution.js'
import { InstantiationService } from '../../di/instantiationService.js'
import { ServiceCollection } from '../../di/serviceCollection.js'
import { LifecycleService } from '../../lifecycle/lifecycleService.js'
import { ILifecycleService, LifecyclePhase } from '../../lifecycle/lifecycleService.js'

// Helper: a minimal workbench contribution that records when it was instantiated
function makeContributionClass(log: string[]): new () => Disposable {
  class TestContribution extends Disposable {
    constructor() {
      super()
      log.push('created')
    }
  }
  return TestContribution
}

describe('ContributionsRegistry', () => {
  it('registers and retrieves a contribution by phase', () => {
    const log: string[] = []
    const Ctor = makeContributionClass(log)
    const d = ContributionsRegistry.registerContribution(
      'test.c1',
      Ctor,
      WorkbenchPhase.BlockStartup,
    )

    const list = ContributionsRegistry.getContributions(WorkbenchPhase.BlockStartup)
    expect(list.some((c) => c.id === 'test.c1')).toBe(true)
    d.dispose()
  })

  it('unregistering removes the contribution', () => {
    const Ctor = makeContributionClass([])
    const d = ContributionsRegistry.registerContribution(
      'test.c2',
      Ctor,
      WorkbenchPhase.AfterRestore,
    )
    d.dispose()

    const list = ContributionsRegistry.getContributions(WorkbenchPhase.AfterRestore)
    expect(list.some((c) => c.id === 'test.c2')).toBe(false)
  })

  it('getContributions returns empty array for unknown phase', () => {
    const list = ContributionsRegistry.getContributions(WorkbenchPhase.Eventually)
    expect(Array.isArray(list)).toBe(true)
  })

  it('stores descriptor id, ctor, and phase', () => {
    const Ctor = makeContributionClass([])
    const d = ContributionsRegistry.registerContribution(
      'test.c3',
      Ctor,
      WorkbenchPhase.BlockRestore,
    )

    const list = ContributionsRegistry.getContributions(WorkbenchPhase.BlockRestore)
    const desc = list.find((c) => c.id === 'test.c3')
    expect(desc).toBeDefined()
    expect(desc?.ctor).toBe(Ctor)
    expect(desc?.phase).toBe(WorkbenchPhase.BlockRestore)
    d.dispose()
  })
})

describe('ContributionService.start()', () => {
  function buildServices() {
    const lifecycle = new LifecycleService()
    const services = new ServiceCollection()
    services.set(ILifecycleService, lifecycle)
    const instantiationService = new InstantiationService(services)
    const contributionService = new ContributionService(lifecycle, instantiationService)
    return { lifecycle, instantiationService, contributionService }
  }

  it('instantiates contributions for the requested phase', () => {
    const { contributionService } = buildServices()
    const log: string[] = []
    const Ctor = makeContributionClass(log)
    const d = ContributionsRegistry.registerContribution(
      'svc.c1',
      Ctor,
      WorkbenchPhase.BlockStartup,
    )

    contributionService.start(WorkbenchPhase.BlockStartup)
    expect(log).toContain('created')
    d.dispose()
  })

  it('does not instantiate contributions for other phases', () => {
    const { contributionService } = buildServices()
    const log: string[] = []
    const Ctor = makeContributionClass(log)
    const d = ContributionsRegistry.registerContribution('svc.c2', Ctor, WorkbenchPhase.Eventually)

    contributionService.start(WorkbenchPhase.BlockStartup)
    expect(log).toHaveLength(0)
    d.dispose()
  })

  it('does not instantiate the same contribution twice', () => {
    const { contributionService } = buildServices()
    const log: string[] = []
    const Ctor = makeContributionClass(log)
    const d = ContributionsRegistry.registerContribution(
      'svc.c3',
      Ctor,
      WorkbenchPhase.BlockStartup,
    )

    contributionService.start(WorkbenchPhase.BlockStartup)
    contributionService.start(WorkbenchPhase.BlockStartup)
    expect(log).toHaveLength(1)
    d.dispose()
  })

  it('auto-instantiates contributions when lifecycle phase is reached', async () => {
    const log: string[] = []
    const Ctor = makeContributionClass(log)
    const d = ContributionsRegistry.registerContribution(
      'svc.c4',
      Ctor,
      WorkbenchPhase.BlockRestore,
    )

    const { lifecycle } = buildServices()
    // lifecycle.when(Ready) triggers BlockRestore contributions
    lifecycle.setPhase(LifecyclePhase.Ready)
    await Promise.resolve() // flush microtasks
    await Promise.resolve()

    expect(log).toContain('created')
    d.dispose()
    lifecycle.dispose()
  })
})
