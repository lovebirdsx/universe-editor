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
  /** The editor's Electron executable (`process.execPath`). */
  readonly execPath: string
  /** The app-owned state directory (`app.getPath('userData')`: settings/logs/storage). */
  readonly userDataDir: string
  /** `process.resourcesPath` when packaged; undefined in dev, where the bundled
   *  extensions live in the repo checkout (possibly the open workspace) and must
   *  not be treated as app-owned. */
  readonly appResourcesPath: string | undefined
  /** Full process environment (name → value), undefined entries dropped. */
  readonly env: Readonly<Record<string, string>>
  /** Root of the built-in agent skills tree shipped with the editor
   *  (`<resources>/agent-skills`, laid out as `.claude/skills/<name>/SKILL.md`).
   *  Injected into local ACP sessions as an `additionalDirectories` root so the
   *  bundled skills surface as slash commands; absent when the directory is missing. */
  readonly builtinAgentSkillsRoot?: string
}

export interface IEnvironmentSnapshotService {
  readonly _serviceBrand: undefined

  /** Read the current environment snapshot. */
  getSnapshot(): Promise<IEnvironmentSnapshot>
}

export const IEnvironmentSnapshotService = createDecorator<IEnvironmentSnapshotService>(
  'environmentSnapshotService',
)
