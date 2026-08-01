/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Settings and defaults for interaction responsiveness monitoring.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationService } from '@universe-editor/platform'

export const RESPONSIVENESS_ENABLED_KEY = 'performance.responsiveness.enabled'
export const RESPONSIVENESS_WARN_THRESHOLD_KEY = 'performance.responsiveness.warnThresholdMs'
export const RESPONSIVENESS_STATUS_WARNING_ENABLED_KEY =
  'performance.responsiveness.statusWarning.enabled'

export const DEFAULT_RESPONSIVENESS_WARN_THRESHOLD_MS = 200

export function responsivenessEnabled(configuration: IConfigurationService): boolean {
  return configuration.get<boolean>(RESPONSIVENESS_ENABLED_KEY) ?? true
}

export function responsivenessWarnThresholdMs(configuration: IConfigurationService): number {
  return (
    configuration.get<number>(RESPONSIVENESS_WARN_THRESHOLD_KEY) ??
    DEFAULT_RESPONSIVENESS_WARN_THRESHOLD_MS
  )
}

export function responsivenessStatusWarningEnabled(configuration: IConfigurationService): boolean {
  return configuration.get<boolean>(RESPONSIVENESS_STATUS_WARNING_ENABLED_KEY) ?? false
}
