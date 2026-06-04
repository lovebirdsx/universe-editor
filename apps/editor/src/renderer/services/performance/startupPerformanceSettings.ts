/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Settings and defaults for startup performance warnings.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationService } from '@universe-editor/platform'

export const STARTUP_WARNING_ENABLED_KEY = 'performance.startupWarning.enabled'
export const STARTUP_WARNING_RELEASE_THRESHOLD_KEY = 'performance.startupWarning.releaseThresholdMs'
export const STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY =
  'performance.startupWarning.developmentThresholdMs'

export const DEFAULT_STARTUP_WARNING_RELEASE_THRESHOLD_MS = 1000
export const DEFAULT_STARTUP_WARNING_DEVELOPMENT_THRESHOLD_MS = 4000

export function startupWarningEnabled(
  configuration: IConfigurationService,
  isDevelopment: boolean,
): boolean {
  return configuration.get<boolean>(STARTUP_WARNING_ENABLED_KEY) ?? isDevelopment
}

export function startupWarningThresholdMs(
  configuration: IConfigurationService,
  isDevelopment: boolean,
): number {
  const key = isDevelopment
    ? STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY
    : STARTUP_WARNING_RELEASE_THRESHOLD_KEY
  const fallback = isDevelopment
    ? DEFAULT_STARTUP_WARNING_DEVELOPMENT_THRESHOLD_MS
    : DEFAULT_STARTUP_WARNING_RELEASE_THRESHOLD_MS
  return configuration.get<number>(key) ?? fallback
}
