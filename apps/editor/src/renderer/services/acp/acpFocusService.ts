/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpFocusService — emitter-only renderer service that lets commands / session
 *  switches request focus on the AGENTS prompt input without holding a React
 *  ref across module boundaries. PromptInput subscribes in a useEffect and
 *  calls textarea.focus() on its own ref when the event fires.
 *
 *  Pure renderer-side state; no IPC, no storage. Multiple subscribers may
 *  coexist (e.g. one in PromptInput, one in tests).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, Disposable, Emitter, type Event } from '@universe-editor/platform'

export interface IAcpFocusService {
  readonly _serviceBrand: undefined
  readonly onDidRequestFocus: Event<void>
  requestFocus(): void
}

export const IAcpFocusService = createDecorator<IAcpFocusService>('acpFocusService')

export class AcpFocusService extends Disposable implements IAcpFocusService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidRequestFocus = this._register(new Emitter<void>())
  readonly onDidRequestFocus = this._onDidRequestFocus.event

  requestFocus(): void {
    this._onDidRequestFocus.fire()
  }
}
