/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Minimal CancellationToken stub for VSCode observableInternal/utils/runOnChange.ts.
 *--------------------------------------------------------------------------------------------*/
import { toDisposable, type IDisposable } from '../../lifecycle.js'

export interface CancellationToken {
  readonly isCancellationRequested: boolean
}

export function cancelOnDispose(store: { add(d: IDisposable): void }): CancellationToken {
  let cancelled = false
  store.add(
    toDisposable(() => {
      cancelled = true
    }),
  )
  return {
    get isCancellationRequested() {
      return cancelled
    },
  }
}
