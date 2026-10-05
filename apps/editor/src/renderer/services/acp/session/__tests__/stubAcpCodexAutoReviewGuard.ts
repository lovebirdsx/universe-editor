/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for IAcpCodexAutoReviewGuard — inert unless a test opts in. The
 *  guard only speaks up for a codex session on a custom provider, which these
 *  service-level tests never set up, so `watchSession` returns Disposable.None
 *  and nothing is notified.
 *--------------------------------------------------------------------------------------------*/

import { constObservable, Disposable } from '@universe-editor/platform'
import type {
  AutoReviewAvailability,
  IAcpCodexAutoReviewGuard,
} from '../acpCodexAutoReviewGuard.js'

const AVAILABLE = constObservable<AutoReviewAvailability>('available')

export function stubAcpCodexAutoReviewGuard(): IAcpCodexAutoReviewGuard {
  return {
    _serviceBrand: undefined,
    getAutoReviewAvailability: () => 'available',
    observeAutoReviewAvailability: () => AVAILABLE,
    watchSession: () => Disposable.None,
    refresh: async () => {},
  }
}
