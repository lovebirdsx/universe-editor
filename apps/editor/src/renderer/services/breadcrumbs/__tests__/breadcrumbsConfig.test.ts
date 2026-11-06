/*---------------------------------------------------------------------------------------------
 *  Tests for services/breadcrumbs/breadcrumbsConfig.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IConfigurationService } from '@universe-editor/platform'
import {
  BREADCRUMBS_CONFIG_KEYS,
  DEFAULT_BREADCRUMBS_CONFIG,
  readBreadcrumbsConfig,
} from '../breadcrumbsConfig.js'

function config(values: Record<string, unknown>): Pick<IConfigurationService, 'get'> {
  return {
    get: <T>(key: string, fallback?: T): T => (key in values ? values[key] : fallback) as T,
  }
}

describe('readBreadcrumbsConfig', () => {
  it('returns defaults without a configuration service', () => {
    expect(readBreadcrumbsConfig(undefined)).toEqual(DEFAULT_BREADCRUMBS_CONFIG)
  })

  it('reads every supported key', () => {
    expect(
      readBreadcrumbsConfig(
        config({
          'breadcrumbs.enabled': false,
          'breadcrumbs.filePath': 'last',
          'breadcrumbs.symbolPath': 'off',
          'breadcrumbs.icons': false,
          'breadcrumbs.symbolSortOrder': 'name',
        }),
      ),
    ).toEqual({
      enabled: false,
      filePath: 'last',
      symbolPath: 'off',
      icons: false,
      symbolSortOrder: 'name',
    })
  })

  it('sanitises unknown enum values back to defaults', () => {
    const read = readBreadcrumbsConfig(
      config({
        'breadcrumbs.filePath': 'sometimes',
        'breadcrumbs.symbolPath': 42,
        'breadcrumbs.symbolSortOrder': 'alphabetical',
      }),
    )
    expect(read.filePath).toBe('on')
    expect(read.symbolPath).toBe('on')
    expect(read.symbolSortOrder).toBe('position')
  })

  it('lists every key the UI subscribes to', () => {
    expect(BREADCRUMBS_CONFIG_KEYS).toEqual([
      'breadcrumbs.enabled',
      'breadcrumbs.filePath',
      'breadcrumbs.symbolPath',
      'breadcrumbs.icons',
      'breadcrumbs.symbolSortOrder',
    ])
  })
})
