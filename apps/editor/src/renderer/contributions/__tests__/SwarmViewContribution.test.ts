/*---------------------------------------------------------------------------------------------
 *  The Swarm Reviews container must track Perforce workspace availability AND the
 *  `perforce.swarm.enabled` switch: registered only while both hold, deregistered
 *  otherwise — so non-Perforce workspaces never see the entry point at all, and
 *  switching the integration off takes the whole container (both views) with it.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  observableValue,
  ViewContainerRegistry,
  ViewRegistry,
  type IConfigurationChangeEvent,
  type IConfigurationService,
  type IObservable,
  type IStorageService,
} from '@universe-editor/platform'
import type { IScmService, IScmSourceControlModel } from '../../services/extensions/ScmService.js'
import { swarmNeedsActionCount } from '../../services/swarm/swarmViewState.js'
import { SwarmViewContribution } from '../SwarmViewContribution.js'

const SWARM_ENABLED_KEY = 'perforce.swarm.enabled'

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

/** Mutable config fake: `perforce.swarm.enabled` is driven by setEnabled, every
 *  other key falls back to 0 (preserving the review-window-days read). */
function makeConfiguration(swarmEnabled = true): {
  service: IConfigurationService
  setEnabled: (value: boolean) => void
  fireUnrelated: () => void
} {
  let enabled = swarmEnabled
  const listeners = new Set<(e: IConfigurationChangeEvent) => void>()
  const service = {
    _serviceBrand: undefined,
    get: (key: string) => (key === SWARM_ENABLED_KEY ? enabled : 0),
    onDidChangeConfiguration: (listener: (e: IConfigurationChangeEvent) => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  } as unknown as IConfigurationService
  const fire = (key: string): void => {
    for (const listener of [...listeners]) {
      listener({ keys: [key], affectsConfiguration: (k: string) => k === key })
    }
  }
  return {
    service,
    setEnabled: (value) => {
      enabled = value
      fire(SWARM_ENABLED_KEY)
    },
    fireUnrelated: () => fire('perforce.swarm.reviewWindowDays'),
  }
}

describe('SwarmViewContribution', () => {
  const contributions: SwarmViewContribution[] = []

  afterEach(() => {
    for (const c of contributions.splice(0)) c.dispose()
    // Module-level singleton shared across the file — leave it clean.
    swarmNeedsActionCount.set(0)
  })

  function create(initial: readonly IScmSourceControlModel[], swarmEnabled = true) {
    const scm = makeScm(initial)
    const config = makeConfiguration(swarmEnabled)
    const contribution = new SwarmViewContribution(makeStorage(), config.service, scm.service)
    contributions.push(contribution)
    return { ...scm, config }
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
      return new SwarmViewContribution(makeStorage(), makeConfiguration().service, scm.service)
    })()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeDefined()
    contribution.dispose()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeUndefined()
  })

  it('stays unregistered in a perforce workspace while perforce.swarm.enabled is false', () => {
    create([perforceControl], false)
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeUndefined()
    expect(ViewRegistry.getView('workbench.view.swarm.reviews')).toBeUndefined()
    expect(ViewRegistry.getView('workbench.view.swarm.changes')).toBeUndefined()
  })

  it('deregisters the whole container when the switch is turned off, re-registers when it returns', () => {
    const { config } = create([perforceControl])
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeDefined()

    config.setEnabled(false)
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeUndefined()
    expect(ViewRegistry.getView('workbench.view.swarm.reviews')).toBeUndefined()
    expect(ViewRegistry.getView('workbench.view.swarm.changes')).toBeUndefined()

    config.setEnabled(true)
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBeDefined()
    expect(ViewRegistry.getView('workbench.view.swarm.reviews')).toBeDefined()
    expect(ViewRegistry.getView('workbench.view.swarm.changes')).toBeDefined()
  })

  it('clears the needs-action count when the switch is turned off', () => {
    const { config } = create([perforceControl])
    swarmNeedsActionCount.set(5)

    config.setEnabled(false)
    expect(swarmNeedsActionCount.observable.get()).toBe(0)
  })

  // The unmounting view's effect has no cleanup, so it can still write the count
  // it was showing after the deregistration above zeroed it. Re-registering must
  // therefore start from zero instead of inheriting whatever survived — else the
  // stale number flashes on the badge and the host status bar until the view's
  // first reload lands.
  it('does not let a count written while off survive a disable/enable round trip', () => {
    const { config } = create([perforceControl])

    config.setEnabled(false)
    swarmNeedsActionCount.set(5)
    config.setEnabled(true)

    expect(swarmNeedsActionCount.observable.get()).toBe(0)
  })

  it('keeps the count while the switch stays on and only unrelated config changes', () => {
    const { config } = create([perforceControl])
    swarmNeedsActionCount.set(5)

    config.fireUnrelated()
    expect(swarmNeedsActionCount.observable.get()).toBe(5)
  })

  it('does not churn registrations on unrelated configuration changes', () => {
    const { config } = create([perforceControl])
    const registered = ViewContainerRegistry.getViewContainer('workbench.view.swarm')
    config.fireUnrelated()
    expect(ViewContainerRegistry.getViewContainer('workbench.view.swarm')).toBe(registered)
  })
})
