/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WorkbenchPartsContribution — instantiates the workbench Parts and bridges the
 *  document FocusTracker to each Part's onDidFocus/onDidBlur.
 *
 *  Parts stay array-managed (not registerSingleton'd): they are not singleton
 *  services and their only job on construction is to self-register with the
 *  LayoutService. Running this as a BlockStartup contribution keeps that
 *  side-effect on the lifecycle timeline instead of in bootstrap.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IFocusTrackerService,
  IInstantiationService,
  ILayoutService,
  MutableDisposable,
  type IFocusTrackerService as IFocusTrackerServiceType,
  type IInstantiationService as IInstantiationServiceType,
  type ILayoutService as ILayoutServiceType,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { ALL_PART_CTORS } from '../workbench/parts/index.js'

export class WorkbenchPartsContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IInstantiationService instantiation: IInstantiationServiceType,
    @ILayoutService layoutService: ILayoutServiceType,
    @IFocusTrackerService focusTracker: IFocusTrackerServiceType,
  ) {
    super()

    // Each Part auto-registers with the LayoutService on construction; React
    // lookups (`getPart`) resolve them.
    for (const Ctor of ALL_PART_CTORS) {
      this._register(instantiation.createInstance(Ctor))
    }

    // Bridge FocusTracker → per-Part onDidFocus/onDidBlur. We use trackElement on
    // each Part's container as it mounts; unmount clears the tracker disposable.
    // _register chains to ContributionService → workbenchStore (a singleton root),
    // so the leak detector won't report the tracker subscription when beforeunload
    // fires before React unmounts.
    for (const part of layoutService.getParts()) {
      const trackerSub = this._register(new MutableDisposable())
      const attach = () => {
        const container = part.getContainer() as unknown as HTMLElement | undefined
        if (!container) {
          trackerSub.clear()
          return
        }
        trackerSub.value = focusTracker.trackElement(container, (focused) => {
          ;(part as unknown as { _notifyFocusChange(f: boolean): void })._notifyFocusChange(focused)
        })
      }
      this._register(part.onDidMount(attach))
      this._register(part.onDidUnmount(() => trackerSub.clear()))
      if (part.mountState === 'mounted') attach()
    }
  }
}
