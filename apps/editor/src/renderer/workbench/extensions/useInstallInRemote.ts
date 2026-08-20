/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useInstallInRemote — resolve whether a local-side extension can be installed
 *  into the remote workspace (the marketplace has an entry for it) and expose the
 *  install action. Availability is undefined while the marketplace lookup is in
 *  flight; it re-checks when the entry id changes (entry objects are re-created
 *  every facade refresh, so keying on the id keeps the effect from re-running
 *  forever).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import { useService } from '../useService.js'
import {
  IExtensionsWorkbenchService,
  type IExtensionEntry,
} from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'

export function useInstallInRemote(entry: IExtensionEntry): {
  /** true = installable, false = no marketplace entry, undefined = resolving. */
  available: boolean | undefined
  install: () => void
} {
  const service = useService(IExtensionsWorkbenchService)
  const { id } = entry
  const [available, setAvailable] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setAvailable(undefined)
    void service.canInstallInRemote(id).then((v) => {
      if (alive) setAvailable(v)
    })
    return () => {
      alive = false
    }
  }, [service, id])

  const install = useCallback(() => {
    void service.installInRemote(entry)
  }, [service, entry])

  return { available, install }
}
