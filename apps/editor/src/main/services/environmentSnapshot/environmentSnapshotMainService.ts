/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side IEnvironmentSnapshotService: exposes the process env / home / cwd to
 *  the renderer so the configuration resolver can expand `${env:X}`, `${userHome}`
 *  and bare `${cwd}`. Thin — just reads process/os once per call.
 *
 *  The full env is surfaced deliberately (parity with VSCode's env resolver); it is
 *  in-memory only, never persisted and never written to settings.json, so it does
 *  not touch the AI-secret storage boundary. The terminal already spawns children
 *  with this env, so exposing it to the renderer does not widen the trust surface.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'node:os'
import { app } from 'electron'
import type {
  IEnvironmentSnapshot,
  IEnvironmentSnapshotService,
} from '../../../shared/ipc/environmentSnapshotService.js'

export interface EnvironmentSnapshotSources {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: () => string
  readonly userHome: () => string
  readonly execPath: () => string
  readonly userDataDir: () => string
  readonly appResourcesPath: () => string | undefined
}

const defaultSources: EnvironmentSnapshotSources = {
  env: process.env,
  cwd: () => process.cwd(),
  userHome: () => homedir(),
  execPath: () => process.execPath,
  userDataDir: () => app.getPath('userData'),
  appResourcesPath: () => (app.isPackaged ? process.resourcesPath : undefined),
}

export class EnvironmentSnapshotMainService implements IEnvironmentSnapshotService {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _sources: EnvironmentSnapshotSources = defaultSources) {}

  getSnapshot(): Promise<IEnvironmentSnapshot> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(this._sources.env)) {
      if (typeof value === 'string') env[key] = value
    }
    return Promise.resolve({
      userHome: this._sources.userHome(),
      cwd: this._sources.cwd(),
      execPath: this._sources.execPath(),
      userDataDir: this._sources.userDataDir(),
      appResourcesPath: this._sources.appResourcesPath(),
      env,
    })
  }
}
