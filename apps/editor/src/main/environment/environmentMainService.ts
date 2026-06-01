/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single entry point for reading CLI args / env vars / deployment config files in
 *  the main process. Wraps platform's ConfigResolver over the declarative items in
 *  configItems.ts. Constructed once at the very top of index.ts, before any
 *  app.getPath('userData') call. The file source is appended lazily (resolveFileConfig)
 *  once userData is known — see the two-phase startup note in index.ts.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CliConfigSource,
  ConfigResolver,
  EnvConfigSource,
  FileConfigSource,
  buildHelpMessage,
  buildVersionMessage,
} from '@universe-editor/platform'
import {
  APP_DATA,
  CLI_OPTIONS,
  HELP,
  HOME,
  IS_E2E,
  RENDERER_DEBUG,
  RENDERER_URL,
  UPDATE_URL,
  USER_DATA_DIR,
  USER_PROFILE,
  VERSION,
  XDG_CONFIG_HOME,
} from './configItems.js'
import type { ResolveEnv } from '../productPaths.js'

const UPDATE_CONFIG_FILE = 'update-config.json'

export interface EnvironmentMainServiceOptions {
  argv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  isDev: boolean
  /** Defaults to process.platform; injectable for tests. */
  platform?: NodeJS.Platform
  /** Defaults to os.homedir(); injectable for tests. */
  homeDir?: string
}

export class EnvironmentMainService {
  private readonly _resolver: ConfigResolver
  private readonly _isDev: boolean
  private readonly _platform: NodeJS.Platform
  private readonly _homeDir: string

  constructor(opts: EnvironmentMainServiceOptions) {
    this._isDev = opts.isDev
    this._platform = opts.platform ?? process.platform
    this._homeDir = opts.homeDir ?? homedir()
    this._resolver = new ConfigResolver([
      new CliConfigSource(opts.argv),
      new EnvConfigSource(opts.env),
    ])
  }

  // ---- Phase one: available from cli + env alone -----------------------------

  get isDev(): boolean {
    return this._isDev
  }

  get userDataDirOverride(): string | undefined {
    return this._resolver.get(USER_DATA_DIR)
  }

  get isE2E(): boolean {
    return this._resolver.get(IS_E2E) ?? false
  }

  get rendererUrl(): string | undefined {
    return this._resolver.get(RENDERER_URL)
  }

  get rendererDebug(): boolean {
    return this._resolver.get(RENDERER_DEBUG) ?? false
  }

  // ---- CLI commands (--help / --version) -------------------------------------

  get shouldPrintHelp(): boolean {
    return this._resolver.get(HELP) ?? false
  }

  get shouldPrintVersion(): boolean {
    return this._resolver.get(VERSION) ?? false
  }

  formatHelp(executableName: string, version: string): string {
    return buildHelpMessage({ executableName, version, items: CLI_OPTIONS })
  }

  formatVersion(productName: string, version: string, extraLines?: readonly string[]): string {
    return buildVersionMessage({
      productName,
      version,
      ...(extraLines !== undefined ? { extraLines } : {}),
    })
  }

  /** Produces the ResolveEnv consumed by productPaths.resolveProductIdentity. */
  toResolveEnv(): ResolveEnv {
    const home = this._resolver.get(HOME) ?? this._resolver.get(USER_PROFILE) ?? this._homeDir
    const override = this.userDataDirOverride
    const appData = this._resolver.get(APP_DATA)
    const xdgConfigHome = this._resolver.get(XDG_CONFIG_HOME)
    return {
      isDev: this._isDev,
      isE2E: this.isE2E,
      platform: this._platform,
      home,
      ...(override !== undefined ? { override } : {}),
      ...(appData !== undefined ? { appData } : {}),
      ...(xdgConfigHome !== undefined ? { xdgConfigHome } : {}),
    }
  }

  // ---- Phase two: requires a resolved userData directory ----------------------

  /** Append the deployment config file (<userDataDir>/update-config.json) as the
   *  lowest-priority source. Missing/invalid files are tolerated silently. */
  resolveFileConfig(userDataDir: string): void {
    const data = this._readJsonFile(join(userDataDir, UPDATE_CONFIG_FILE))
    this._resolver.appendSource(new FileConfigSource(data))
  }

  get updateUrl(): string | undefined {
    return this._resolver.get(UPDATE_URL)
  }

  private _readJsonFile(path: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
}
