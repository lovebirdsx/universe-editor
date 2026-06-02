/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's WorkbenchContributionsRegistry (workbench/common/contributions.ts).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../base/lifecycle.js'
import { createDecorator, IInstantiationService, ServicesAccessor } from '../di/instantiation.js'
import { ILifecycleService, LifecyclePhase } from '../lifecycle/lifecycleService.js'

/**
 * Mirrors the lifecycle phases for contribution scheduling.
 * Contributions are instantiated by the DI container at the specified phase.
 */
export const enum WorkbenchPhase {
  /** Instantiated immediately when DI container is set up (blocks startup). */
  BlockStartup = LifecyclePhase.Starting,
  /** Instantiated before the window is shown (blocks UI render). */
  BlockRestore = LifecyclePhase.Ready,
  /** Instantiated after editors are restored (after restore). */
  AfterRestore = LifecyclePhase.Restored,
  /** Instantiated lazily during idle time. */
  Eventually = LifecyclePhase.Eventually,
}

/**
 * All workbench contributions must implement this interface.
 * Typically the contribution registers commands, menus, and event listeners in its constructor.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IWorkbenchContribution extends IDisposable {}

export interface IContributionDescriptor {
  readonly id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly ctor: new (...args: any[]) => IWorkbenchContribution
  readonly phase: WorkbenchPhase
}

export interface IContributionsRegistry {
  /**
   * Register a contribution class to be instantiated at a given lifecycle phase.
   */
  registerContribution(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: new (...args: any[]) => IWorkbenchContribution,
    phase: WorkbenchPhase,
  ): IDisposable

  /**
   * Get all registered contributions for a given phase.
   */
  getContributions(phase: WorkbenchPhase): readonly IContributionDescriptor[]
}

class ContributionsRegistryImpl implements IContributionsRegistry {
  private readonly _contributions = new Map<WorkbenchPhase, IContributionDescriptor[]>()

  registerContribution(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: new (...args: any[]) => IWorkbenchContribution,
    phase: WorkbenchPhase,
  ): IDisposable {
    let list = this._contributions.get(phase)
    if (!list) {
      list = []
      this._contributions.set(phase, list)
    }

    const descriptor: IContributionDescriptor = { id, ctor, phase }
    list.push(descriptor)

    return {
      dispose: () => {
        const arr = this._contributions.get(phase)
        if (arr) {
          const idx = arr.indexOf(descriptor)
          if (idx !== -1) {
            arr.splice(idx, 1)
          }
        }
      },
    }
  }

  getContributions(phase: WorkbenchPhase): readonly IContributionDescriptor[] {
    return this._contributions.get(phase) ?? []
  }
}

export const ContributionsRegistry: IContributionsRegistry = new ContributionsRegistryImpl()

// -------- Contribution Service --------

export interface IContributionService {
  readonly _serviceBrand: undefined
  /**
   * Start all contributions for the given phase.
   * Must be called in phase order (BlockStartup → BlockRestore → AfterRestore → Eventually).
   */
  start(phase: WorkbenchPhase): void
}

export const IContributionService = createDecorator<IContributionService>('contributionService')

/**
 * Manages the instantiation of all registered workbench contributions.
 * Wire this up with the lifecycle service to automatically advance through phases.
 */
export class ContributionService extends Disposable implements IContributionService {
  declare readonly _serviceBrand: undefined

  private readonly _instances = new Map<string, IWorkbenchContribution>()

  constructor(
    @ILifecycleService private readonly _lifecycle: ILifecycleService,
    @IInstantiationService private readonly _instantiationService: IInstantiationService,
  ) {
    super()
    // Schedule each phase when the lifecycle advances
    this._lifecycle
      .when(LifecyclePhase.Starting)
      .then(() => this.start(WorkbenchPhase.BlockStartup))
    this._lifecycle.when(LifecyclePhase.Ready).then(() => this.start(WorkbenchPhase.BlockRestore))
    this._lifecycle
      .when(LifecyclePhase.Restored)
      .then(() => this.start(WorkbenchPhase.AfterRestore))
    this._lifecycle
      .when(LifecyclePhase.Eventually)
      .then(() => this.start(WorkbenchPhase.Eventually))
  }

  start(phase: WorkbenchPhase): void {
    for (const descriptor of ContributionsRegistry.getContributions(phase)) {
      if (this._instances.has(descriptor.id)) {
        continue // already instantiated
      }
      const instance = this._register(this._instantiationService.createInstance(descriptor.ctor))
      this._instances.set(descriptor.id, instance)
    }
  }

  /**
   * For testing: manually instantiate a contribution with a given accessor.
   */
  startWithAccessor(phase: WorkbenchPhase, accessor: ServicesAccessor): void {
    void accessor // accessor kept for future use
    this.start(phase)
  }
}
