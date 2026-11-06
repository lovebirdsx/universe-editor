/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Breadcrumb settings model. Kept free of React/DI so the value sanitation can
 *  be unit-tested; the hook only subscribes to changes.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationService } from '@universe-editor/platform'

export type BreadcrumbsPathMode = 'on' | 'off' | 'last'
export type BreadcrumbsSymbolSortOrder = 'position' | 'name' | 'type'

export interface BreadcrumbsConfigValues {
  readonly enabled: boolean
  readonly filePath: BreadcrumbsPathMode
  readonly symbolPath: BreadcrumbsPathMode
  readonly icons: boolean
  readonly symbolSortOrder: BreadcrumbsSymbolSortOrder
}

export const DEFAULT_BREADCRUMBS_CONFIG: BreadcrumbsConfigValues = {
  enabled: true,
  filePath: 'on',
  symbolPath: 'on',
  icons: true,
  symbolSortOrder: 'position',
}

/** Every key the breadcrumb UI reads; `affectsConfiguration` is exact-match in this repo. */
export const BREADCRUMBS_CONFIG_KEYS = [
  'breadcrumbs.enabled',
  'breadcrumbs.filePath',
  'breadcrumbs.symbolPath',
  'breadcrumbs.icons',
  'breadcrumbs.symbolSortOrder',
] as const

const PATH_MODES: readonly string[] = ['on', 'off', 'last']
const SORT_ORDERS: readonly string[] = ['position', 'name', 'type']

function sanitizeMode(value: unknown, fallback: BreadcrumbsPathMode): BreadcrumbsPathMode {
  return typeof value === 'string' && PATH_MODES.includes(value)
    ? (value as BreadcrumbsPathMode)
    : fallback
}

function sanitizeSortOrder(value: unknown): BreadcrumbsSymbolSortOrder {
  return typeof value === 'string' && SORT_ORDERS.includes(value)
    ? (value as BreadcrumbsSymbolSortOrder)
    : DEFAULT_BREADCRUMBS_CONFIG.symbolSortOrder
}

export function readBreadcrumbsConfig(
  config: Pick<IConfigurationService, 'get'> | undefined,
): BreadcrumbsConfigValues {
  if (!config) return DEFAULT_BREADCRUMBS_CONFIG
  return {
    enabled: config.get<boolean>('breadcrumbs.enabled', true) !== false,
    filePath: sanitizeMode(
      config.get<unknown>('breadcrumbs.filePath', DEFAULT_BREADCRUMBS_CONFIG.filePath),
      DEFAULT_BREADCRUMBS_CONFIG.filePath,
    ),
    symbolPath: sanitizeMode(
      config.get<unknown>('breadcrumbs.symbolPath', DEFAULT_BREADCRUMBS_CONFIG.symbolPath),
      DEFAULT_BREADCRUMBS_CONFIG.symbolPath,
    ),
    icons: config.get<boolean>('breadcrumbs.icons', true) !== false,
    symbolSortOrder: sanitizeSortOrder(
      config.get<unknown>(
        'breadcrumbs.symbolSortOrder',
        DEFAULT_BREADCRUMBS_CONFIG.symbolSortOrder,
      ),
    ),
  }
}
