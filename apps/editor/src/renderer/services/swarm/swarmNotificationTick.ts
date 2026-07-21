/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Module-level routing seam between the host-driven poll tick and the live
 *  SwarmReviewNotificationContribution instance. The poll timer lives in the
 *  perforce extension host (a Node child process Chromium never background-
 *  throttles, unlike the renderer's own setInterval which freezes while the window
 *  sits in the background — the root cause of "notifications never fire overnight").
 *  The host ticks by invoking the `_workbench.swarmPollTick` command; that Action2
 *  is stateless, so it routes here to reach the DI-owned contribution's refresh().
 *--------------------------------------------------------------------------------------------*/

type TickHandler = () => Promise<void>

let handler: TickHandler | undefined

/** The live contribution registers its refresh() here on construction. */
export function setSwarmNotificationTickHandler(fn: TickHandler | undefined): void {
  handler = fn
}

/** Invoked by the `_workbench.swarmPollTick` Action2 when the host timer fires.
 *  No-op when no contribution is mounted (e.g. before AfterRestore). */
export async function driveSwarmNotificationTick(): Promise<void> {
  await handler?.()
}
