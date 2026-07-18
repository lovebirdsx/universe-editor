/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side Extension Host process host. Spawns the bundled extension-host
 *  bootstrap through Electron's own Node runtime (process.execPath +
 *  ELECTRON_RUN_AS_NODE) — no system node/npx required — and pumps its stdio
 *  to the renderer keyed by an opaque handle. The renderer drives the RPC
 *  (platform ChannelServer/ChannelClient over a newline-framed protocol) on top
 *  of the raw byte stream. Mirrors AcpHostMainService.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { app } from 'electron'
import {
  createNamedLogger,
  Disposable,
  DisposableStore,
  Emitter,
  mark,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import { buildChildEnv } from '../process/env.js'
import { decodeDiagnostic } from '../process/decode.js'
import { ManagedChildProcess } from '../process/managedChildProcess.js'
import type {
  ExtHostExitEvent,
  ExtHostStartResult,
  ExtHostStartSpec,
  ExtHostStdioChunk,
  IExtensionHostService,
} from '../../../shared/ipc/extensionHostService.js'
import { resolveTsServerPaths } from './tsServerPaths.js'
import { resolveUserExtensionsDir } from './userExtensionsDir.js'
import { resolveBuiltinExtensionsDir } from './builtinExtensionsDir.js'
import { PerfMarks } from '../../../shared/perf/marks.js'

/** Grace period after closing the host's stdin before we force-kill its tree. */
const EXT_HOST_GRACEFUL_STOP_MS = 2000

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

/** Resolves the vendored TS language-server CLI + tsserver. Injectable for tests. */
export type TsServerPathsResolver = () => { cli: string; tsserver: string }

const defaultSpawner: ExtHostSpawner = (command, args, options) =>
  spawn(command, [...args], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // process.execPath is a real binary (its path may contain spaces), so a
    // shell wrapper would mis-quote it. Always off, like AcpHost's runAsNode.
    shell: false,
  })

/** Bootstrap entry relative to the repo root in the dev tree. */
const ENTRY_DEV = 'packages/extension-host/dist/bootstrap.js'
/** Bootstrap entry under `resourcesPath` in a packaged build. */
const ENTRY_PACKAGED = 'extension-host/dist/bootstrap.js'

/**
 * Walk up from `app.getAppPath()` looking for a repo-relative path. Tolerates
 * both `electron .` (appPath = apps/editor) and the e2e `electron out/main/index.js`
 * layout (appPath points deeper), same approach as `resolveTsServerPaths`.
 */
function resolveFromRepo(relative: string): string {
  let dir = app.getAppPath()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, relative)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(app.getAppPath(), '../..', relative)
}

const defaultResolveEntry: ExtHostEntryResolver = () =>
  app.isPackaged ? path.join(process.resourcesPath, ENTRY_PACKAGED) : resolveFromRepo(ENTRY_DEV)

const defaultResolveExtensionsDir: ExtHostExtensionsDirResolver = () =>
  resolveBuiltinExtensionsDir()

/** External (user-installed) extensions live under the user-data directory. */
const defaultResolveUserExtensionsDir: ExtHostExtensionsDirResolver = () =>
  resolveUserExtensionsDir()

interface ProcEntry {
  readonly proc: ManagedChildProcess
  /** Owns `proc` + its stdout/stderr/exit subscriptions; disposed on exit or service dispose. */
  readonly store: DisposableStore
  readonly stdoutDecoder: StringDecoder
  /** Carry-over of a partial (newline-less) stderr chunk, flushed line by line. */
  stderrLineBuffer: string
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

  /** Set once the first host process spawns, so the perf mark fires only once. */
  private _didMarkFirstSpawn = false

  constructor(
    private readonly _spawn: ExtHostSpawner = defaultSpawner,
    private readonly _resolveEntry: ExtHostEntryResolver = defaultResolveEntry,
    private readonly _resolveExtensionsDir: ExtHostExtensionsDirResolver = defaultResolveExtensionsDir,
    private readonly _resolveUserExtensionsDir: ExtHostExtensionsDirResolver = defaultResolveUserExtensionsDir,
    private readonly _resolveTsServerPaths: TsServerPathsResolver = resolveTsServerPaths,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'extensionHost', name: 'Extension Host' })
  }

  start(spec?: ExtHostStartSpec): Promise<ExtHostStartResult> {
    const handle = randomUUID()
    // The host runs as Electron-as-node, so re-add ELECTRON_RUN_AS_NODE.
    const env = buildChildEnv(process.env, { runAsNode: true })

    const command = process.execPath
    const entry = this._resolveEntry()
    const args: string[] = []

    // A single local extension host scans both the bundled built-in dir and the
    // user (external) dir. Trust is a runtime gate (Workspace Trust), not a
    // process/capability split — every local extension gets the full API and raw
    // Node access once its workspace is trusted.
    env.UNIVERSE_BUILTIN_EXTENSIONS_DIR = spec?.extensionsDir ?? this._resolveExtensionsDir()
    env.UNIVERSE_USER_EXTENSIONS_DIR = spec?.userExtensionsDir ?? this._resolveUserExtensionsDir()
    // The `typescript` built-in plugin spawns the LSP server itself; hand it the
    // vendored CLI + tsserver paths (the only Electron-aware resolution).
    const { cli, tsserver } = this._resolveTsServerPaths()
    env.UNIVERSE_TSLS_CLI = cli
    env.UNIVERSE_TSLS_TSSERVER = tsserver
    // Parent dir for extensions' persistent cross-session storage
    // (`context.globalStoragePath` = `<dir>/<extId>`).
    env.UNIVERSE_GLOBAL_STORAGE_DIR = path.join(app.getPath('userData'), 'extensionGlobalStorage')

    // The open folder, surfaced to extensions as `workspace.rootPath`.
    if (spec?.workspaceRoot !== undefined) {
      env.UNIVERSE_WORKSPACE_ROOT = spec.workspaceRoot
    }
    // Display locale for manifest NLS (package.nls.<locale>.json) resolution.
    if (spec?.locale !== undefined) {
      env.UNIVERSE_DISPLAY_LOCALE = spec.locale
    }
    // Disabled / quarantined extensions the host must skip scanning.
    if (spec?.disabledIds && spec.disabledIds.length > 0) {
      env.UNIVERSE_DISABLED_EXTENSIONS = spec.disabledIds.join(',')
    }
    args.push(entry)

    let proc: ManagedChildProcess
    try {
      // The host forks grandchildren — the `typescript` built-in plugin spawns
      // the typescript-language-server CLI, which itself forks tsserver. Graceful
      // stop (`stopAll` / renderer `beforeunload` → stdin EOF) lets that CLI reap
      // its own tsserver via its exit hook, which is the primary path. `treeKill`
      // is the BACKSTOP for when graceful is skipped or overruns (dispose on
      // will-quit, the stop-grace timeout): a plain SIGKILL to the host would
      // orphan tsserver — it survives app quit holding pipes open, blocking
      // Playwright teardown and leaking a stray electron.exe for real users — so
      // termination recurses the PID tree instead. No-op off Windows.
      proc = new ManagedChildProcess(this._spawn(command, args, { env }), {
        logger: this._logger,
        label: handle,
        treeKill: true,
      })
    } catch (err) {
      this._logger.warn(`spawn failed handle=${handle} entry=${entry}: ${(err as Error).message}`)
      return Promise.reject(err as Error)
    }

    const store = new DisposableStore()
    store.add(proc)
    const procEntry: ProcEntry = {
      proc,
      store,
      stdoutDecoder: new StringDecoder('utf8'),
      stderrLineBuffer: '',
      exited: false,
    }
    this._procs.set(handle, procEntry)

    if (!this._didMarkFirstSpawn) {
      this._didMarkFirstSpawn = true
      mark(PerfMarks.extHostDidSpawn)
    }

    store.add(
      proc.onStdout((data: Buffer) => {
        this._onStdout.fire({ handle, data: procEntry.stdoutDecoder.write(data) })
      }),
    )
    store.add(
      proc.onStderr((data: Buffer) => {
        const text = decodeDiagnostic(data)
        this._onStderr.fire({ handle, data: text })
        // Also persist to disk. The renderer routes stderr only to a non-persisted
        // Output channel, so a crash's stack (the host has no uncaughtException
        // handler — Node prints it to stderr then exits 1) would be lost once the
        // window is gone. Buffer by line so multi-chunk stacks stay readable.
        this._logStderr(handle, procEntry, text)
      }),
    )
    store.add(
      proc.onDidExit((exit) => {
        if (procEntry.exited) return
        procEntry.exited = true
        this._flushStderr(handle, procEntry)
        if (exit.error !== undefined) {
          this._logger.warn(`proc error handle=${handle}: ${exit.error}`)
          this._onExit.fire({ handle, code: null, signal: null, error: exit.error })
        } else {
          const msg = `exit handle=${handle} code=${exit.code} signal=${exit.signal}`
          if (exit.code === 0 || exit.code === null) {
            this._logger.info(msg)
          } else {
            this._logger.warn(msg)
          }
          this._onExit.fire({ handle, code: exit.code, signal: exit.signal })
        }
        this._procs.delete(handle)
        store.dispose()
      }),
    )

    this._logger.info(`start handle=${handle} entry=${entry}`)
    return Promise.resolve({ handle })
  }

  /** Append complete stderr lines to the log, holding any trailing partial line. */
  private _logStderr(handle: string, entry: ProcEntry, chunk: string): void {
    const buf = entry.stderrLineBuffer + chunk
    const lastNl = buf.lastIndexOf('\n')
    if (lastNl === -1) {
      entry.stderrLineBuffer = buf
      return
    }
    const complete = buf.slice(0, lastNl)
    entry.stderrLineBuffer = buf.slice(lastNl + 1)
    for (const line of complete.split('\n')) {
      if (line.length > 0) this._logger.warn(`[stderr ${handle}] ${line}`)
    }
  }

  /** Flush any buffered partial stderr line (e.g. a crash's final stack frame). */
  private _flushStderr(handle: string, entry: ProcEntry): void {
    const rest = entry.stderrLineBuffer.trimEnd()
    entry.stderrLineBuffer = ''
    if (rest.length > 0) this._logger.warn(`[stderr ${handle}] ${rest}`)
  }

  writeStdin(handle: string, data: string): Promise<void> {
    const entry = this._procs.get(handle)
    if (!entry || entry.exited) {
      return Promise.reject(new Error(`ExtensionHost: unknown or exited handle ${handle}`))
    }
    return entry.proc.writeStdin(data).catch((err: Error) => {
      if (/not writable|has exited/.test(err.message)) {
        throw new Error(`ExtensionHost: stdin is not writable for handle ${handle}`)
      }
      throw err
    })
  }

  stop(handle: string): Promise<void> {
    const entry = this._procs.get(handle)
    if (!entry || entry.exited) {
      return Promise.resolve()
    }
    // Graceful stop: close stdin so the host runs its own shutdown (deactivating
    // extensions, which synchronously tree-kill their children — notably the
    // typescript plugin's tsserver) and exits cleanly. A hard kill here would
    // reap only the host and orphan tsserver. Tree-kill is the backstop if the
    // host doesn't exit within the grace window.
    entry.proc.endStdin()
    const grace = setTimeout(() => {
      if (!entry.exited) entry.proc.kill()
    }, EXT_HOST_GRACEFUL_STOP_MS)
    // Don't keep the event loop alive just for the backstop timer.
    grace.unref?.()
    entry.store.add({ dispose: () => clearTimeout(grace) })
    return Promise.resolve()
  }

  /**
   * Gracefully stop every live host and AWAIT each one's exit. Unlike {@link stop}
   * (fire-and-forget, used on reload where main keeps running to drive the
   * cascade), this is the app-quit primitive: closing a host's stdin lets it run
   * its own shutdown — deactivating extensions, which close their children's stdin
   * so those reap their own grandchildren (the typescript plugin → tsserver). That
   * cascade needs the event loop, so `will-quit` (synchronous) is too late. Call
   * this from the async `before-quit` path before `app.quit()`, so the whole tree
   * is reaped cleanly instead of hard-killed (which orphans a slow-starting
   * tsserver out of the PID snapshot). Backstop tree-kill if a host overruns.
   */
  stopAll(): Promise<void> {
    const waits: Promise<void>[] = []
    for (const [, entry] of this._procs) {
      if (entry.exited) continue
      waits.push(
        new Promise<void>((resolve) => {
          const timers: ReturnType<typeof setTimeout>[] = []
          const done = entry.store.add(
            entry.proc.onDidExit(() => {
              for (const t of timers) clearTimeout(t)
              resolve()
            }),
          )
          entry.proc.endStdin()
          if (entry.exited) return // exited synchronously on endStdin
          const grace = setTimeout(() => {
            done.dispose()
            if (!entry.exited) entry.proc.kill()
            resolve()
          }, EXT_HOST_GRACEFUL_STOP_MS)
          grace.unref?.()
          timers.push(grace)
        }),
      )
    }
    return Promise.all(waits).then(() => undefined)
  }

  hasUserExtensions(): Promise<boolean> {
    try {
      const dir = this._resolveUserExtensionsDir()
      const entries = readdirSync(dir, { withFileTypes: true })
      // Follow symlinked dir entries too: an e2e/dev-linked extension (VSCode's
      // `--extensionDevelopmentPath` model) is a directory junction, reported as
      // a symlink — not a directory — by readdir. Mirrors the scanner's filter.
      return Promise.resolve(
        entries.some(
          (e) =>
            e.isDirectory() ||
            (e.isSymbolicLink() &&
              statSync(path.join(dir, e.name), { throwIfNoEntry: false })?.isDirectory() === true),
        ),
      )
    } catch {
      return Promise.resolve(false) // ENOENT (no dir) or unreadable → nothing to load
    }
  }

  override dispose(): void {
    for (const [handle, entry] of this._procs) {
      if (!entry.exited) {
        entry.store.dispose()
        this._logger.info(`dispose killed handle=${handle}`)
      }
    }
    this._procs.clear()
    super.dispose()
  }
}
