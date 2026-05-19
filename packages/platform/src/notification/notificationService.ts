/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Aligned with VSCode's INotificationService public API surface.
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import type { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

export const enum Severity {
  Info = 0,
  Warning = 1,
  Error = 2,
}

export interface IPromptChoice {
  readonly label: string
  readonly run: () => void
  readonly isSecondary?: boolean
}

export interface INotificationProgress {
  /** Report current progress. Calling this implicitly starts the spinner. */
  report(state: { message?: string; increment?: number }): void
  /** Mark progress as complete — hides the spinner. */
  done(): void
}

export interface INotificationHandle extends IDisposable {
  readonly id: string
  readonly progress: INotificationProgress
  updateMessage(message: string): void
  updateSeverity(severity: Severity): void
}

export interface INotification {
  readonly id: string
  severity: Severity
  message: string
  readonly sticky: boolean
  readonly timestamp: number
  readonly actions?: ReadonlyArray<IPromptChoice>
  /** True once the notification has been shown for its auto-dismiss period. */
  read: boolean
  /** True once the user has explicitly dismissed this notification. */
  dismissed: boolean
  progress?: { message?: string; increment?: number; done: boolean }
}

export interface INotificationService {
  readonly _serviceBrand: undefined

  /**
   * All non-dismissed notifications (both read and unread).
   * Toast shows `filter(n => !n.read)`, center shows all.
   */
  readonly notifications: IObservable<readonly INotification[]>

  /** Count of unread (not yet auto-dismissed from toast) notifications. */
  readonly unreadCount: IObservable<number>

  /** Whether the notification center panel is currently visible. */
  readonly centerVisible: IObservable<boolean>

  notify(opts: {
    severity: Severity
    message: string
    actions?: IPromptChoice[]
    sticky?: boolean
  }): INotificationHandle

  /**
   * Show a sticky prompt and resolve when any choice is picked or when the
   * notification is dismissed without a choice.
   */
  prompt(severity: Severity, message: string, choices: IPromptChoice[]): Promise<void>

  /** Shorthand for a non-blocking Info notification. */
  status(message: string, opts?: { sticky?: boolean }): INotificationHandle

  dismiss(id: string): void
  clearAll(): void
  toggleCenter(): void
}

export const INotificationService = createDecorator<INotificationService>('notificationService')
