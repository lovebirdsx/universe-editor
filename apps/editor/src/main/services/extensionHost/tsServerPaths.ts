/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves the vendored typescript-language-server CLI + the bundled tsserver,
 *  injected into the trusted extension host's env (UNIVERSE_TSLS_CLI /
 *  UNIVERSE_TSLS_TSSERVER) so the `typescript` plugin can spawn the LSP server
 *  itself without touching any Electron API. This Electron-aware path resolution
 *  is the one piece that must stay in the main process.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { app } from 'electron'
import { parse, type ParseError } from 'jsonc-parser'
import {
  DEFAULT_TS_SERVER_IMPLEMENTATION,
  type TsServerImplementationName,
} from '../../../shared/tsServerImplementation.js'

/**
 * Which language-server implementation the `typescript` plugin spawns.
 * `tsls` = vendored typescript-language-server driving the JS tsserver;
 * `native` = the Go port's own LSP (`tsgo --lsp --stdio`, single process).
 * `version` feeds the renderer status-bar item (main owns package reads).
 */
export type TsServerSpec =
  | { kind: 'tsls'; cli: string; tsserver: string; version: string }
  | { kind: 'native'; binary: string; version: string }

export type TsServerImplementation = TsServerImplementationName

/** Where the winning preference value came from — surfaced in the per-spawn
 *  startup log to debug "the setting didn't take". */
export type TsServerPreferenceSource =
  | 'binary-env'
  | 'env'
  | 'workspace'
  | 'vscode-workspace'
  | 'user'
  | 'default'

export interface TsServerPreferenceResult {
  readonly value: TsServerImplementation | { binary: string }
  readonly source: TsServerPreferenceSource
}

/**
 * Preferred server implementation, in priority order: explicit binary
 * (`UNIVERSE_TSGO_BIN`) > env (`UNIVERSE_TS_SERVER`) > workspace project
 * settings (`<workspaceRoot>/.universe-editor/settings.json`) > workspace
 * VSCode-compat settings (`<workspaceRoot>/.vscode/settings.json`) > user
 * settings.json (`typescript.server.implementation`, read directly from
 * `settingsDir` — the extension host starts before any renderer-side
 * ConfigurationService exists, and this key is only consumed in main) >
 * default. The workspace layering mirrors the renderer's ConfigurationTarget
 * order (Project > VSCodeWorkspace > User).
 */
export type TsServerPreference = (workspaceRoot?: string) => TsServerPreferenceResult

/** CLI under the vendor dir, found by walking up from getAppPath in dev. */
const CLI_VENDOR_REL =
  'vendor/typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs'
/** CLI relative to `process.resourcesPath` in a packaged build. */
const CLI_PACKAGED_REL =
  'typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs'

/** tsgo exe relative to `process.resourcesPath` in a packaged build; staged
 *  (with its sibling lib .d.ts files and package.json) by
 *  scripts/release/runtime-resources.mjs. */
const NATIVE_PACKAGED_REL = `tsgo/lib/${process.platform === 'win32' ? 'tsgo.exe' : 'tsgo'}`

/** tsserver.js sits beside the CLI's node_modules (…/node_modules/typescript/lib/tsserver.js). */
function tsserverFor(cli: string): string {
  return path.resolve(path.dirname(cli), '../../typescript/lib/tsserver.js')
}

/** Read `version` from a package.json, or undefined when unreadable. */
function readPackageVersion(packageJsonPath: string): string | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (data !== null && typeof data === 'object') {
      const version = (data as Record<string, unknown>).version
      if (typeof version === 'string') return version
    }
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Locate the vendored CLI by walking up from `app.getAppPath()` (dev) or under
 * `process.resourcesPath` (packaged). The dev walk-up tolerates both `electron .`
 * (appPath = apps/editor) and the e2e `electron out/main/index.js` layout.
 */
export function resolveTsServerPaths(): { cli: string; tsserver: string } {
  if (app.isPackaged) {
    const cli = path.join(process.resourcesPath, CLI_PACKAGED_REL)
    return { cli, tsserver: tsserverFor(cli) }
  }
  let dir = app.getAppPath()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, CLI_VENDOR_REL)
    if (existsSync(candidate)) return { cli: candidate, tsserver: tsserverFor(candidate) }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const cli = path.resolve(app.getAppPath(), '../..', CLI_VENDOR_REL)
  return { cli, tsserver: tsserverFor(cli) }
}

/**
 * Resolve which server to run per the preference chain (see TsServerPreference).
 * The native binary comes from the dev dependency `@typescript/native-preview`
 * in dev (its platform package ships the per-OS exe) or from the staged
 * `tsgo/` tree under `process.resourcesPath` in packaged builds. When native
 * is preferred but no binary is found, fall back to tsls.
 */
export function resolveTsServerSpec(
  preference: TsServerPreference,
  workspaceRoot?: string,
): TsServerSpec {
  return specForPreferenceValue(preference(workspaceRoot).value)
}

function specForPreferenceValue(pref: TsServerImplementation | { binary: string }): TsServerSpec {
  const wantNative = typeof pref === 'object' || pref === 'native'
  if (typeof pref === 'object') {
    return {
      kind: 'native',
      binary: pref.binary,
      version: versionForBinary(pref.binary) ?? 'unknown',
    }
  }
  if (wantNative) {
    const binary = resolveNativePreviewBinary()
    if (binary) return { kind: 'native', binary, version: versionForBinary(binary) ?? 'unknown' }
  }
  const { cli, tsserver } = resolveTsServerPaths()
  return {
    kind: 'tsls',
    cli,
    tsserver,
    version: readPackageVersion(path.resolve(tsserver, '../../package.json')) ?? 'unknown',
  }
}

/** Platform-package layout ships the exe at lib/tsgo, one dir below its package.json. */
function versionForBinary(binary: string): string | undefined {
  return readPackageVersion(path.resolve(path.dirname(binary), '../package.json'))
}

/** Workspace config dirs consulted for `typescript.server.implementation`,
 *  highest precedence first — mirrors the renderer's Project and
 *  VSCodeWorkspace layers (`.universe-editor` is read-write, `.vscode` the
 *  read-only VSCode-compat layer). */
const WORKSPACE_SETTINGS_DIRS = ['.universe-editor', '.vscode'] as const

/** Default preference chain: explicit binary env > selection env > workspace
 *  project settings > workspace .vscode settings > user settings.json > the
 *  shared default (kept in sync with the ConfigurationRegistry schema). */
export function defaultTsServerPreference(settingsDir: string): TsServerPreference {
  return (workspaceRoot) => {
    const binaryOverride = process.env.UNIVERSE_TSGO_BIN
    if (binaryOverride) return { value: { binary: binaryOverride }, source: 'binary-env' }
    const envChoice = process.env.UNIVERSE_TS_SERVER
    if (envChoice === 'native' || envChoice === 'tsls') {
      return { value: envChoice, source: 'env' }
    }
    if (workspaceRoot !== undefined) {
      for (const dir of WORKSPACE_SETTINGS_DIRS) {
        const configured = readServerImplementationSetting(
          path.join(workspaceRoot, dir, 'settings.json'),
        )
        if (configured !== undefined) {
          return {
            value: configured,
            source: dir === '.universe-editor' ? 'workspace' : 'vscode-workspace',
          }
        }
      }
    }
    const fromUser = readServerImplementationSetting(path.join(settingsDir, 'settings.json'))
    if (fromUser !== undefined) return { value: fromUser, source: 'user' }
    return { value: DEFAULT_TS_SERVER_IMPLEMENTATION, source: 'default' }
  }
}

/** Lazily resolve the spec on every call — all settings layers are re-read per
 *  host spawn, so editing `typescript.server.implementation` + restarting the
 *  window (which relaunches the host) picks the new server, and each window's
 *  workspace gets its own layering. Logs one line per spawn with the winning
 *  source (debugging "the setting didn't take"). */
export function createTsServerSpecResolver(
  settingsDir: string,
): (workspaceRoot?: string) => TsServerSpec {
  const preference = defaultTsServerPreference(settingsDir)
  return (workspaceRoot) => {
    const { value, source } = preference(workspaceRoot)
    const spec = specForPreferenceValue(value)
    console.log(
      `[tsServer] kind=${spec.kind} version=${spec.version} source=${source} ` +
        `workspace=${workspaceRoot ?? '(none)'} settingsDir=${settingsDir}`,
    )
    return spec
  }
}

/** `typescript.server.implementation` from a settings.json file, or undefined
 *  when absent/unreadable/invalid/not a known value. Parsed as JSONC (comments
 *  + trailing commas) like every other config read in main — the migrated user
 *  settings.json carries a header comment that plain JSON.parse would choke on. */
function readServerImplementationSetting(settingsPath: string): TsServerImplementation | undefined {
  try {
    const errors: ParseError[] = []
    const data: unknown = parse(readFileSync(settingsPath, 'utf8'), errors, {
      allowTrailingComma: true,
    })
    if (errors.length > 0 || data === null || typeof data !== 'object' || Array.isArray(data)) {
      return undefined
    }
    const value = (data as Record<string, unknown>)['typescript.server.implementation']
    return value === 'native' || value === 'tsls' ? value : undefined
  } catch {
    return undefined
  }
}

/** Packaged: the staged exe under resourcesPath. Dev: resolve the
 *  `@typescript/native-preview-<platform>-<arch>` tsgo exe via the package's
 *  own resolver semantics (mirrors its lib/getExePath.js). */
function resolveNativePreviewBinary(): string | undefined {
  if (app.isPackaged) {
    const exe = path.join(process.resourcesPath, NATIVE_PACKAGED_REL)
    return existsSync(exe) ? exe : undefined
  }
  const platformPackage = `@typescript/native-preview-${process.platform}-${process.arch}`
  try {
    // pnpm doesn't hoist the platform package to the top-level node_modules;
    // resolve it from inside @typescript/native-preview, where it is a sibling.
    // realpath first: the hoisted entry is a symlink, and createRequire resolves
    // from the literal path, not through it.
    const previewPkg = realpathSync(
      createRequire(import.meta.url).resolve('@typescript/native-preview/package.json'),
    )
    const packageJsonPath = createRequire(previewPkg).resolve(`${platformPackage}/package.json`)
    const exe = path.join(
      path.dirname(packageJsonPath),
      'lib',
      process.platform === 'win32' ? 'tsgo.exe' : 'tsgo',
    )
    return existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
}
