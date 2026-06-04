/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side Extension Host process host. Spawns the bundled extension-host
 *  bootstrap through Electron's own Node runtime (process.execPath +
 *  ELECTRON_RUN_AS_NODE) — no system node/npx required — and pumps its stdio
 *  to the renderer keyed by an opaque handle. The renderer drives the RPC
 *  (platform ChannelServer/ChannelClient over a newline-framed protocol) on top
 *  of the raw byte stream. Mirrors AcpHostMainService.
 *--------------------------------------------------------------------------------------------*/

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { app } from 'electron'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import type {
  ExtHostExitEvent,
  ExtHostStartResult,
  ExtHostStartSpec,
  ExtHostStdioChunk,
  IExtensionHostService,
} from '../../../shared/ipc/extensionHostService.js'

/** Spawner abstraction — injectable for tests so we don't launch real processes. */
export type ExtHostSpawner = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

/** Resolves the bundled extension-host bootstrap entry. Injectable for tests. */
export type ExtHostEntryResolver = () => string

/** Resolves the built-in extensions directory the host scans. Injectable for tests. */
export type ExtHostExtensionsDirResolver = () => string

const defaultSpawner: ExtHostSpawner = (command, args, options) =>
  spawn(command, [...args], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // process.execPath is a real binary (its path may contain spaces), so a
    // shell wrapper would mis-quote it. Always off, like AcpHost's runAsNode.
    shell: false,
  })

/** Bootstrap entry relative to `app.getAppPath()` in the dev tree (apps/editor → repo root). */
const ENTRY_DEV = '../../packages/extension-host/dist/bootstrap.js'
/** Bootstrap entry under `resourcesPath` in a packaged build. */
const ENTRY_PACKAGED = 'extension-host/dist/bootstrap.js'

const defaultResolveEntry: ExtHostEntryResolver = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, ENTRY_PACKAGED)
    : path.resolve(app.getAppPath(), ENTRY_DEV)

/** Built-in extensions tree: repo `extensions/` in dev, `resources/extensions/` when packaged. */
const EXTENSIONS_DEV = '../../extensions'
const EXTENSIONS_PACKAGED = 'extensions'

const defaultResolveExtensionsDir: ExtHostExtensionsDirResolver = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, EXTENSIONS_PACKAGED)
    : path.resolve(app.getAppPath(), EXTENSIONS_DEV)

/** External (user-installed) extensions live under the user-data directory. */
const defaultResolveUserExtensionsDir: ExtHostExtensionsDirResolver = () =>
  path.join(app.getPath('userData'), 'extensions')

/**
 * Variables stripped from the child env (same rationale as AcpHost): the
 * ELECTRON_* flags would make a Node-shaped child reinterpret its entrypoint as
 * an Electron helper, and NODE_OPTIONS could inject --inspect / --require.
 * ELECTRON_RUN_AS_NODE is re-added explicitly after sanitizing because the host
 * IS launched as Electron-as-node.
 */
const ENV_DENYLIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
]

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })
const OEM_FALLBACK = makeFallbackDecoder()

function makeFallbackDecoder(): InstanceType<typeof TextDecoder> {
  try {
    return new TextDecoder('gb18030')
  } catch {
    return new TextDecoder('utf-8')
  }
}

function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (ENV_DENYLIST.includes(k)) continue
    out[k] = v
  }
  return out
}

interface ProcEntry {
  readonly proc: ChildProcessWithoutNullStreams
  exited: boolean
}

export class ExtensionHostMainService extends Disposable implements IExtensionHostService {
  declare readonly _serviceBrand: undefined

  private readonly _onStdout = this._register(new Emitter<ExtHostStdioChunk>())
  readonly onStdout = this._onStdout.event

  private readonly _onStderr = this._register(new Emitter<ExtHostStdioChunk>())
  readonly onStderr = this._onStderr.event

  private readonly _onExit = this._register(new Emitter<ExtHostExitEvent>())
  readonly onExit = this._onExit.event

  private readonly _procs = new Map<string, ProcEntry>()

  private readonly _logger: ILogger

  /** Cached result of probing whether this runtime accepts the Node permission model. */
  private _permissionModelSupported: boolean | undefined

  constructor(
    private readonly _spawn: ExtHostSpawner = defaultSpawner,
    private readonly _resolveEntry: ExtHostEntryResolver = defaultResolveEntry,
    private readonly _resolveExtensionsDir: ExtHostExtensionsDirResolver = defaultResolveExtensionsDir,
    private readonly _resolveUserExtensionsDir: ExtHostExtensionsDirResolver = defaultResolveUserExtensionsDir,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'extensionHost', name: 'Extension Host' })
  }

  start(spec?: ExtHostStartSpec): Promise<ExtHostStartResult> {
    const handle = randomUUID()
    const kind = spec?.kind ?? 'trusted'
    const env = sanitizeEnv(process.env)
    // Re-added after the denylist strip: the host runs as Electron-as-node.
    env.ELECTRON_RUN_AS_NODE = '1'
    env.UNIVERSE_EXT_HOST_KIND = kind

    const command = process.execPath
    const entry = this._resolveEntry()
    const args: string[] = []

    if (kind === 'restricted') {
      const extDir = spec?.extensionsDir ?? this._resolveUserExtensionsDir()
      env.UNIVERSE_USER_EXTENSIONS_DIR = extDir
      // Best-effort OS-level lockdown: read only the extensions dir + the
      // bootstrap; no workspace read, no write, no child_process. Workspace fs
      // must go through the main gateway. Skipped when the runtime (Electron)
      // doesn't accept the flags — soft isolation then relies on not handing
      // external code raw capabilities. See the plan's "honest boundary" note.
      args.push(...this._permissionArgs(extDir, path.dirname(entry)))
    } else {
      // Tell the host where to scan for built-in extensions (survives the denylist).
      env.UNIVERSE_BUILTIN_EXTENSIONS_DIR = spec?.extensionsDir ?? this._resolveExtensionsDir()
    }

    // The open folder, surfaced to extensions as `workspace.rootPath`.
    if (spec?.workspaceRoot !== undefined) {
      env.UNIVERSE_WORKSPACE_ROOT = spec.workspaceRoot
    }
    args.push(entry)

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = this._spawn(command, args, { env })
    } catch (err) {
      this._logger.warn(`spawn failed handle=${handle} entry=${entry}: ${(err as Error).message}`)
      return Promise.reject(err as Error)
    }

    const procEntry: ProcEntry = { proc, exited: false }
    this._procs.set(handle, procEntry)

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (data: string) => {
      this._onStdout.fire({ handle, data })
    })
    proc.stderr.on('data', (data: Buffer) => {
      this._onStderr.fire({ handle, data: this._decodeDiag(data) })
    })
    proc.on('error', (err) => {
      this._logger.warn(`proc error handle=${handle}: ${err.message}`)
      if (procEntry.exited) return
      procEntry.exited = true
      this._onExit.fire({ handle, code: null, signal: null, error: err.message })
      this._procs.delete(handle)
    })
    proc.on('exit', (code, signal) => {
      if (procEntry.exited) return
      procEntry.exited = true
      const msg = `exit handle=${handle} code=${code} signal=${signal}`
      if (code === 0 || code === null) {
        this._logger.info(msg)
      } else {
        this._logger.warn(msg)
      }
      this._onExit.fire({ handle, code, signal })
      this._procs.delete(handle)
    })

    this._logger.info(`start handle=${handle} entry=${entry}`)
    return Promise.resolve({ handle })
  }

  writeStdin(handle: string, data: string): Promise<void> {
    const entry = this._procs.get(handle)
    if (!entry || entry.exited) {
      return Promise.reject(new Error(`ExtensionHost: unknown or exited handle ${handle}`))
    }
    const stdin = entry.proc.stdin
    if (stdin.destroyed || stdin.writable === false) {
      return Promise.reject(new Error(`ExtensionHost: stdin is not writable for handle ${handle}`))
    }
    return new Promise<void>((resolve, reject) => {
      stdin.write(data, 'utf8', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  stop(handle: string): Promise<void> {
    const entry = this._procs.get(handle)
    if (!entry || entry.exited) {
      return Promise.resolve()
    }
    try {
      entry.proc.kill()
    } catch (err) {
      this._logger.warn(`kill failed handle=${handle}: ${(err as Error).message}`)
    }
    return Promise.resolve()
  }

  hasUserExtensions(): Promise<boolean> {
    try {
      const dir = this._resolveUserExtensionsDir()
      const entries = readdirSync(dir, { withFileTypes: true })
      return Promise.resolve(entries.some((e) => e.isDirectory()))
    } catch {
      return Promise.resolve(false) // ENOENT (no dir) or unreadable → nothing to load
    }
  }

  /**
   * Build the Node permission-model argv for a restricted host, or [] otherwise.
   *
   * OFF by default: narrowing fs-read can stop Electron-as-node from reading its
   * own resources and crash-loop the host, and we can't verify support on every
   * runtime. Opt in with `UNIVERSE_EXT_HOST_PERMISSION=1`; even then we probe
   * first and fall back to soft isolation (no raw capability handed to external
   * code + fs only via the gateway) if the runtime rejects the flags.
   */
  private _permissionArgs(extDir: string, entryDir: string): string[] {
    if (process.env.UNIVERSE_EXT_HOST_PERMISSION !== '1') return []
    if (!this._supportsPermissionModel()) {
      this._logger.warn(
        'restricted extension host: Node permission model unavailable; falling back to soft isolation',
      )
      return []
    }
    // Read the extension code + the bootstrap; deny workspace read, all writes,
    // and child_process. Workspace access is forced through the main fs gateway.
    return ['--experimental-permission', `--allow-fs-read=${extDir}`, `--allow-fs-read=${entryDir}`]
  }

  /** Probe (once) whether the runtime accepts `--experimental-permission`. */
  private _supportsPermissionModel(): boolean {
    if (this._permissionModelSupported !== undefined) return this._permissionModelSupported
    let supported = false
    try {
      const res = spawnSync(
        process.execPath,
        ['--experimental-permission', '--allow-fs-read=*', '-e', '0'],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 5000 },
      )
      supported = res.status === 0
    } catch {
      supported = false
    }
    this._permissionModelSupported = supported
    return supported
  }

  private _decodeDiag(buf: Buffer): string {
    try {
      return UTF8_STRICT.decode(buf)
    } catch {
      return OEM_FALLBACK.decode(buf)
    }
  }

  override dispose(): void {
    for (const [handle, entry] of this._procs) {
      if (!entry.exited) {
        try {
          entry.proc.kill()
        } catch {
          // ignore — shutting down
        }
        this._logger.info(`dispose killed handle=${handle}`)
      }
    }
    this._procs.clear()
    super.dispose()
  }
}
