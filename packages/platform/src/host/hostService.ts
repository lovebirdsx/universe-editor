/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IHostService (workbench/services/host/browser/host.ts).
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { createDecorator } from '../di/instantiation.js'

export type HostPlatform = 'win32' | 'darwin' | 'linux' | 'unknown'

/**
 * Abstraction over the host process / OS window. Insulates renderer code from
 * direct `window.api` access so that components can be tested with a fake host
 * and so that future targets (web, headless) can swap the implementation.
 */
export interface IHostService {
  readonly _serviceBrand: undefined

  /** OS family the renderer is running on. Stable for the lifetime of the session. */
  readonly platform: HostPlatform

  /** Whether the host window is currently maximized. */
  readonly isMaximized: IObservable<boolean>

  minimizeWindow(): Promise<void>
  /** Toggle between maximized and restored. */
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
}

export const IHostService = createDecorator<IHostService>('hostService')
