/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Errors whose *kind* drives scheduling decisions rather than failure accounting.
 *--------------------------------------------------------------------------------------------*/

/**
 * The event was accepted but cannot start right now (remote workspace offline /
 * no window): keep it pending, release the slot, and do not count a failure.
 */
export class DeferredRunError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'DeferredRunError'
  }
}

/** A remote call was about to run after the connection left `connected`. */
export class RemoteIoUnavailableError extends Error {
  constructor(readonly authority: string) {
    super(`remote '${authority}' is not connected`)
    this.name = 'RemoteIoUnavailableError'
  }
}
