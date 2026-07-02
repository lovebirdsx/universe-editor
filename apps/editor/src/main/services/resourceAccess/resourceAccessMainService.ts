/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side IResourceAccessService: forwards the renderer's allow-list grants to
 *  the universe-app protocol's shared root set. Thin by design — the actual
 *  path-boundary enforcement lives in resourceProtocol.ts.
 *--------------------------------------------------------------------------------------------*/

import type { IResourceAccessService } from '../../../shared/ipc/resourceAccessService.js'
import { allowResourceRoots } from '../../ipc/resourceProtocol.js'

export class ResourceAccessMainService implements IResourceAccessService {
  declare readonly _serviceBrand: undefined

  allowRoots(dirPaths: readonly string[]): Promise<void> {
    allowResourceRoots(dirPaths)
    return Promise.resolve()
  }
}
