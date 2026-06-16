/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Subscribe a component to IViewDescriptorService so it re-renders whenever the
 *  runtime view↔container mapping (move / reorder / collapse / generated
 *  containers) changes. Returns the service for querying.
 *--------------------------------------------------------------------------------------------*/

import { IViewDescriptorService } from '@universe-editor/platform'
import type { IViewDescriptorService as IViewDescriptorServiceType } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'

export function useViewDescriptors(): IViewDescriptorServiceType {
  const service = useService(IViewDescriptorService)
  useObservable(service.version)
  return service
}
