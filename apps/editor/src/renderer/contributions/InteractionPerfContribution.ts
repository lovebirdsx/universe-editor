/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Gates the always-on interaction responsiveness floor on configuration:
 *  starts the service's observers when enabled (default on, release builds
 *  included — passive observers cost ~nothing), applies warn-threshold
 *  changes live, and stops cleanly when the user turns monitoring off.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IInteractionPerfService } from '../services/performance/InteractionPerfService.js'
import {
  RESPONSIVENESS_ENABLED_KEY,
  RESPONSIVENESS_WARN_THRESHOLD_KEY,
  responsivenessEnabled,
  responsivenessWarnThresholdMs,
} from '../services/performance/interactionPerfSettings.js'

export class InteractionPerfContribution extends Disposable implements IWorkbenchContribution {
  private _running = false

  constructor(
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IInteractionPerfService private readonly _interactionPerf: IInteractionPerfService,
  ) {
    super()
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (
          !e.affectsConfiguration(RESPONSIVENESS_ENABLED_KEY) &&
          !e.affectsConfiguration(RESPONSIVENESS_WARN_THRESHOLD_KEY)
        ) {
          return
        }
        this._apply()
      }),
    )
    this._apply()
  }

  private _apply(): void {
    const enabled = responsivenessEnabled(this._configuration)
    const warnThresholdMs = responsivenessWarnThresholdMs(this._configuration)
    if (enabled) {
      // start() is idempotent — re-applying just refreshes the threshold.
      this._interactionPerf.start({ warnThresholdMs })
      this._running = true
    } else if (this._running) {
      this._interactionPerf.stop()
      this._running = false
    }
  }
}
