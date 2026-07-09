/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolve an extension's icon to a `data:` URL via the workbench facade. Both
 *  marketplace icons (remote https, blocked by the renderer CSP) and locally
 *  installed / built-in icons (read from `file://`, also blocked) are fetched +
 *  encoded by main. Returns '' until loaded or when there's no icon — callers
 *  fall back to a semantic glyph.
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
  // An icon exists if the gallery advertises one, or the extension is installed
  // (it may declare `manifest.icon` on disk — main resolves that).
  const hasIcon = Boolean(entry.gallery?.iconUrl) || entry.installed
  useEffect(() => {
    if (!hasIcon) {
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
  }, [service, entry, hasIcon])
  return url
}
