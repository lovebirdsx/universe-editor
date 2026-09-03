/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for ISubProjectService — a configurable in-memory scope list with
 *  no workspace/config detection. Lets AcpSessionService tests construct the
 *  service (which now injects it for the restore coordinator's sub-root hydrate)
 *  without the config schema or a live workspace.
 *--------------------------------------------------------------------------------------------*/

import { ISubProjectService, type SubProjectScope } from '../acpSubProjectService.js'

export function stubSubProjectService(scopes: readonly SubProjectScope[] = []): ISubProjectService {
  return {
    _serviceBrand: undefined,
    getScopes: async () => [...scopes],
    getConfiguredScopes: () => scopes.filter((s) => s.source !== 'detected'),
  } as unknown as ISubProjectService
}
