/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  E2E-only observation seam for SwarmReviewNotificationContribution. The desktop
 *  notification itself is raised main-side and gated on window blur + OS support,
 *  neither of which holds in a headless Playwright run — so a spec cannot observe
 *  the OS toast. Instead the contribution records here each set of review ids it
 *  decided to notify about (its actual job) plus the last actionable set (so a spec
 *  can tell when the baseline has primed), and exposes a hook to drive its poll
 *  deterministically. Populated only under UNIVERSE_E2E=1.
 *--------------------------------------------------------------------------------------------*/

export interface SwarmNotificationE2E {
  /** Ids of each batch of newly-actionable reviews the contribution notified for. */
  readonly notified: string[][]
  /** The actionable id set computed on the most recent poll (lets a spec detect
   *  when the baseline has primed off a successful dashboard fetch). */
  lastActionable: string[]
  /** Set by the live contribution so a spec can drive one poll cycle synchronously. */
  driveRefresh?: () => Promise<void>
}

export const swarmNotificationE2E: SwarmNotificationE2E = {
  notified: [],
  lastActionable: [],
}
