/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IActivityService — drives the Activity Bar badges (e.g. unsaved files on the
 *  Explorer, changed files on Source Control). Mirrors VSCode's
 *  `IActivityService.showActivity(viewContainerId, badge)`: callers push a badge
 *  and receive a disposable; the Activity Bar subscribes per container id.
 *
 *  Each container keeps a stack of badges so multiple providers can contribute;
 *  the top of the stack is the one shown. Disposing a handle removes that badge
 *  and re-surfaces whatever sits below it.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  observableValue,
  toDisposable,
  type IDisposable,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'

export interface IActivityBadge {
  readonly count: number
}

export interface IActivityService {
  readonly _serviceBrand: undefined
  /** Push a badge onto a container; dispose the handle to remove it. */
  showActivity(containerId: string, badge: IActivityBadge): IDisposable
  /** Subscribe to a container's current badge. Stable per id, safe for useObservable. */
  getBadge(containerId: string): IObservable<IActivityBadge | undefined>
}

export const IActivityService = createDecorator<IActivityService>('activityService')

interface IBadgeEntry {
  readonly stack: IActivityBadge[]
  readonly observable: ISettableObservable<IActivityBadge | undefined>
}

export class ActivityService extends Disposable implements IActivityService {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<string, IBadgeEntry>()

  private _entry(containerId: string): IBadgeEntry {
    let entry = this._entries.get(containerId)
    if (!entry) {
      entry = {
        stack: [],
        observable: observableValue<IActivityBadge | undefined>('activityBadge', undefined),
      }
      this._entries.set(containerId, entry)
    }
    return entry
  }

  showActivity(containerId: string, badge: IActivityBadge): IDisposable {
    const entry = this._entry(containerId)
    entry.stack.push(badge)
    entry.observable.set(badge, undefined)
    return toDisposable(() => {
      const index = entry.stack.indexOf(badge)
      if (index === -1) return
      entry.stack.splice(index, 1)
      entry.observable.set(entry.stack[entry.stack.length - 1], undefined)
    })
  }

  getBadge(containerId: string): IObservable<IActivityBadge | undefined> {
    return this._entry(containerId).observable
  }
}
