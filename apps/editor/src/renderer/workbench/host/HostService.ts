/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IHostService implementation: bridges window.api (preload) into the DI world.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '@universe-editor/platform'
import type { HostPlatform, IHostService } from '@universe-editor/platform'

const KNOWN_PLATFORMS = new Set<HostPlatform>(['win32', 'darwin', 'linux'])

function normalizePlatform(raw: string | undefined): HostPlatform {
  if (raw && (KNOWN_PLATFORMS as Set<string>).has(raw)) {
    return raw as HostPlatform
  }
  return 'unknown'
}

export class HostService implements IHostService {
  declare readonly _serviceBrand: undefined

  readonly platform: HostPlatform
  private readonly _isMaximized = observableValue<boolean>('HostService.isMaximized', false)
  readonly isMaximized = this._isMaximized

  private _detach: (() => void) | undefined

  constructor() {
    const api = typeof window !== 'undefined' ? window.api : undefined
    this.platform = normalizePlatform(api?.platform)

    if (!api) return

    void api.windowIsMaximized().then((v) => {
      this._isMaximized.set(v, undefined)
    })

    this._detach = api.onWindowMaximizeChange((v) => {
      this._isMaximized.set(v, undefined)
    })
  }

  minimizeWindow(): Promise<void> {
    return window.api?.windowMinimize() ?? Promise.resolve()
  }

  toggleMaximizeWindow(): Promise<void> {
    return window.api?.windowMaximize() ?? Promise.resolve()
  }

  closeWindow(): Promise<void> {
    return window.api?.windowClose() ?? Promise.resolve()
  }

  dispose(): void {
    this._detach?.()
    this._detach = undefined
  }
}
