/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process notifier for trigger failures. Kept out of TriggerMainService so the
 *  service stays importable in plain-node tests (no `electron` module there).
 *--------------------------------------------------------------------------------------------*/

import { Notification } from 'electron'
import type { ILogger } from '@universe-editor/platform'

export type TriggerNotifier = (title: string, body: string) => void

export function createTriggerNotifier(logger?: ILogger): TriggerNotifier {
  return (title, body) => {
    // Native bubbles would leak into unrelated e2e specs; the log line is enough there.
    if (process.env['UNIVERSE_E2E'] === '1') {
      logger?.info(`notification skipped (e2e): ${title}`)
      return
    }
    if (!Notification.isSupported()) {
      logger?.warn('notifications are not supported on this platform')
      return
    }
    new Notification({ title, body }).show()
  }
}
