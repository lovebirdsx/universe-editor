/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Loads the AI provider registry (instances + types) once for the agent
 *  settings panels, so credential forms can offer a provider dropdown and the
 *  saved-profile rows can resolve a `providerRef` to a label / base URL.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import {
  IAiModelService,
  type AiProviderInstance,
  type AiProviderType,
} from '@universe-editor/platform'
import { useService } from '../useService.js'

export interface ProviderRegistry {
  readonly providers: readonly AiProviderInstance[]
  readonly types: Readonly<Record<string, AiProviderType>>
}

export function useProviderRegistry(): ProviderRegistry {
  const ai = useService<IAiModelService>(IAiModelService)
  const [providers, setProviders] = useState<readonly AiProviderInstance[]>([])
  const [types, setTypes] = useState<Readonly<Record<string, AiProviderType>>>({})

  useEffect(() => {
    let active = true
    void (async () => {
      const [p, t] = await Promise.all([ai.getProviders(), ai.getProviderTypes()])
      if (!active) return
      setProviders(p)
      setTypes(t)
    })()
    return () => {
      active = false
    }
  }, [ai])

  return { providers, types }
}
