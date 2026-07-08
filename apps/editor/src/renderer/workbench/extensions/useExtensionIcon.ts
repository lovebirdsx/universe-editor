/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolve a marketplace extension's icon to a `data:` URL via the workbench
 *  facade. Marketplace icons are remote https URLs the renderer CSP blocks, so
 *  main fetches + caches them and hands back a data URL. Returns '' until loaded
 *  or when there's no icon — callers fall back to a generic icon.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { useService } from '../useService.js'
import {
  IExtensionsWorkbenchService,
  type IExtensionEntry,
} from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'

export function useExtensionIcon(entry: IExtensionEntry): string {
  const service = useService(IExtensionsWorkbenchService)
  const [url, setUrl] = useState('')
  const iconUrl = entry.gallery?.iconUrl
  useEffect(() => {
    if (!iconUrl) {
      setUrl('')
      return
    }
    let cancelled = false
    void service.getIcon(entry).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [service, entry, iconUrl])
  return url
}
