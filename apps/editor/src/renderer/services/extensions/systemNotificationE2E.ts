/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  E2E-only observation seam for the `_workbench.showSystemNotification` bridge.
 *  The desktop toast itself is raised main-side and gated on window blur + user
 *  presence, neither of which holds in a headless Playwright run — so a spec cannot
 *  observe it. Instead the action records here each crossing it decided on (which is
 *  the bridge's actual job). Populated only under UNIVERSE_E2E=1.
 *--------------------------------------------------------------------------------------------*/

export interface SystemNotificationE2E {
  /** Every `{ title, body }` the bridge action forwarded, in order. */
  readonly notified: { title: string; body: string }[]
}

export const systemNotificationE2E: SystemNotificationE2E = {
  notified: [],
}
