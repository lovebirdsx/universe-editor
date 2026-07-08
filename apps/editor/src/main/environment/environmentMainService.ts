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
import { parse } from 'jsonc-parser'
import {
  CliConfigSource,
  ConfigResolver,
  createDecorator,
  EnvConfigSource,
  FileConfigSource,
  buildHelpMessage,
  buildVersionMessage,
} from '@universe-editor/platform'
import {
  APP_DATA,
  CLI_OPTIONS,
  CONFIG_DIR,
  GALLERY_URL,
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
const CONFIG_LOCATION_FILE = 'config-location.json'

export interface EnvironmentMainServiceOptions {
  argv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  isDev: boolean
  /** Defaults to process.platform; injectable for tests. */
  platform?: NodeJS.Platform
  /** Defaults to os.homedir(); injectable for tests. */
  homeDir?: string
}

// Preset instance in the main DI container (constructed before the container,
// because it resolves the userData path that the container's logger depends on).
export const IEnvironmentMainService =
  createDecorator<EnvironmentMainService>('environmentMainService')

export class EnvironmentMainService {
  private readonly _resolver: ConfigResolver
  private readonly _isDev: boolean
  private readonly _platform: NodeJS.Platform
  private readonly _homeDir: string
  private _userDataDir: string | undefined

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
    this._userDataDir = userDataDir
    const updateData = this._readJsonFile(join(userDataDir, UPDATE_CONFIG_FILE))
    this._resolver.appendSource(new FileConfigSource(updateData))
    const locationData = this._readJsonFile(join(userDataDir, CONFIG_LOCATION_FILE))
    this._resolver.appendSource(new FileConfigSource(locationData))
  }

  get updateUrl(): string | undefined {
    return this._resolver.get(UPDATE_URL)
  }

  get galleryUrl(): string | undefined {
    return this._resolver.get(GALLERY_URL)
  }

  /**
   * Directory to load user settings.json / keybindings.json from. Resolves
   * cli > env > <userData>/config-location.json > userData itself. Falls back to
   * userData when resolveFileConfig hasn't run yet (phase one).
   */
  get configDir(): string {
    return this._resolver.get(CONFIG_DIR) ?? this._userDataDir ?? ''
  }

  /** Provenance of configDir: 'cli' | 'env' | 'file' | 'default'. */
  get configDirOrigin(): string {
    return this._resolver.resolve(CONFIG_DIR).origin
  }

  /** Resolved userData directory (available after resolveFileConfig). */
  get userDataDir(): string {
    return this._userDataDir ?? ''
  }

  private _readJsonFile(path: string): Record<string, unknown> {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return {}
    }
    // Tolerant JSONC parse (comments + trailing commas) — the deployment config
    // files are hand-edited and documented with // comments, so a strict
    // JSON.parse would silently drop a whole valid-looking file over a trailing
    // comma. Aligns with how the rest of the app reads config (jsonc-parser).
    const parsed = parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  }
}
