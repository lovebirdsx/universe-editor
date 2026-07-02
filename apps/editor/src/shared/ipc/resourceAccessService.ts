/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the resource-access allow-list. The renderer declares which
 *  filesystem directories the `universe-app://` protocol may serve (a
 *  markdown preview declares its workspace root + the document's own directory).
 *  The main-side protocol handler rejects any request that escapes these roots,
 *  mirroring VSCode's `localResourceRoots`.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

export interface IResourceAccessService {
  readonly _serviceBrand: undefined
  /** Grant the `universe-app` protocol read access to these directories (and their subtrees). */
  allowRoots(dirPaths: readonly string[]): Promise<void>
}

export const IResourceAccessService =
  createDecorator<IResourceAccessService>('resourceAccessService')
