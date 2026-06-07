/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Toggleable keyboard-shortcut troubleshooting. When enabled, the global
 *  keybinding handler streams per-keystroke dispatch diagnostics to a dedicated
 *  Output channel so "my key did nothing" can be traced. Disabled by default;
 *  the hot dispatch path only pays one boolean check.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  Event,
  IOutputService,
  createDecorator,
  type IOutputChannel,
} from '@universe-editor/platform'

export const KEYBOARD_DEBUG_CHANNEL = 'Keyboard Shortcuts Troubleshooting'

export interface IKeyboardDebugService {
  readonly _serviceBrand: undefined
  readonly enabled: boolean
  readonly onDidChange: Event<boolean>
  /** Flip the troubleshooting state and return the new value. */
  toggle(): boolean
  /** Append one diagnostic line. No-op while disabled. */
  append(line: string): void
}

export const IKeyboardDebugService = createDecorator<IKeyboardDebugService>('keyboardDebugService')

export class KeyboardDebugService extends Disposable implements IKeyboardDebugService {
  declare readonly _serviceBrand: undefined

  private _enabled = false
  private _channel: IOutputChannel | undefined

  private readonly _onDidChange = this._register(new Emitter<boolean>())
  readonly onDidChange: Event<boolean> = this._onDidChange.event

  constructor(@IOutputService private readonly _outputService: IOutputService) {
    super()
  }

  get enabled(): boolean {
    return this._enabled
  }

  toggle(): boolean {
    this._enabled = !this._enabled
    if (this._enabled) this._ensureChannel()
    this._onDidChange.fire(this._enabled)
    return this._enabled
  }

  append(line: string): void {
    if (!this._enabled) return
    this._ensureChannel().appendLine(line)
  }

  private _ensureChannel(): IOutputChannel {
    if (!this._channel) {
      // Plain channel (not kind 'log') so it isn't mistaken for a log-file feed.
      this._channel = this._outputService.createChannel(KEYBOARD_DEBUG_CHANNEL)
    }
    return this._channel
  }
}
