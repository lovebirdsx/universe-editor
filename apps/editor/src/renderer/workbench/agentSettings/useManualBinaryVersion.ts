/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  `acp.allowManualBinaryVersion` as live panel state. Both Binary panels and the
 *  Settings editor write this one user-scoped key, so each panel has to follow a
 *  change made in any of the other surfaces.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { IConfigurationService } from '@universe-editor/platform'
import { binaryVersionPolicy } from '../../services/acp/binaryVersionPolicy.js'
import { useService } from '../useService.js'

export function useManualBinaryVersion(): boolean {
  const config = useService(IConfigurationService)
  const [manual, setManual] = useState(() => binaryVersionPolicy(config) === 'manual')

  useEffect(() => {
    const subscription = config.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('acp.allowManualBinaryVersion')) {
        setManual(binaryVersionPolicy(config) === 'manual')
      }
    })
    return () => subscription.dispose()
  }, [config])

  return manual
}
