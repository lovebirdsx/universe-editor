/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for a one-shot main-process environment snapshot, consumed by the
 *  renderer's ConfigurationResolverService to resolve `${env:X}`, `${userHome}` and
 *  bare `${cwd}` — values the renderer (a browser context) cannot read itself.
 *
 *  Fetched once at startup and cached; the snapshot is treated as stable for the
 *  session, mirroring VSCode's one-time `_envVariablesPromise` / `_userHomePromise`.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

export interface IEnvironmentSnapshot {
  /** The user's home directory (fs path). */
  readonly userHome: string
  /** The main process working directory (`process.cwd()`). */
  readonly cwd: string
  /** Full process environment (name → value), undefined entries dropped. */
  readonly env: Readonly<Record<string, string>>
}

export interface IEnvironmentSnapshotService {
  readonly _serviceBrand: undefined

  /** Read the current environment snapshot. */
  getSnapshot(): Promise<IEnvironmentSnapshot>
}

export const IEnvironmentSnapshotService = createDecorator<IEnvironmentSnapshotService>(
  'environmentSnapshotService',
)
