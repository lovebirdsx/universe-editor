/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Loads the resolved AI providers once for the agent settings panels, so the
 *  authentication forms can offer a provider dropdown (filtered by protocol) and
 *  derive the per-CLI credential from the selected entry.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import {
  IAiModelService,
  resolveProviderEntries,
  type AiResolvedProvider,
} from '@universe-editor/platform'
import { useService } from '../useService.js'

export interface ProviderRegistry {
  readonly providers: readonly AiResolvedProvider[]
}

export function useProviderRegistry(): ProviderRegistry {
  const ai = useService<IAiModelService>(IAiModelService)
  const [providers, setProviders] = useState<readonly AiResolvedProvider[]>([])

  useEffect(() => {
    let active = true
    void (async () => {
      const [entries, knowledge] = await Promise.all([ai.getProviders(), ai.getModelKnowledge()])
      if (!active) return
      setProviders(resolveProviderEntries(entries, knowledge).providers)
    })()
    return () => {
      active = false
    }
  }, [ai])

  return { providers }
}
