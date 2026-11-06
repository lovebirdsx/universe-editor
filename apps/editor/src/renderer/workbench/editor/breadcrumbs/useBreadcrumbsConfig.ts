/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Subscribes the breadcrumb bar to its settings. Every key is checked
 *  individually because ConfigurationService.affectsConfiguration is exact-match
 *  (a section name silently matches nothing).
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { IConfigurationService } from '@universe-editor/platform'
import { useOptionalService } from '../../useService.js'
import {
  BREADCRUMBS_CONFIG_KEYS,
  readBreadcrumbsConfig,
  type BreadcrumbsConfigValues,
} from '../../../services/breadcrumbs/breadcrumbsConfig.js'

export function useBreadcrumbsConfig(): BreadcrumbsConfigValues {
  const config = useOptionalService(IConfigurationService)
  const [values, setValues] = useState(() => readBreadcrumbsConfig(config))

  useEffect(() => {
    if (!config) return
    setValues(readBreadcrumbsConfig(config))
    const subscription = config.onDidChangeConfiguration((e) => {
      if (BREADCRUMBS_CONFIG_KEYS.some((key) => e.affectsConfiguration(key))) {
        setValues(readBreadcrumbsConfig(config))
      }
    })
    return () => subscription.dispose()
  }, [config])

  return values
}
