/**
 * Thin wrapper over the p4delta CLI — the alternative engine for the reconcile /
 * clean / sync questions this extension asks. δ is a one-shot Rust tool that
 * answers them (and the narrow queries built on top) much faster than `p4`, and
 * an optional one: when it is absent everything keeps running on the native
 * `p4` paths.
 *
 * Same shape as p4Service: spawn with an argument array and `shell: false`,
 * sanitized child env, the shared ConcurrencyGate, a watchdog and a stdout byte
 * cap, and no async callback that may throw (host-crash red line 4). It never
 * rejects — a spawn failure, a watchdog kill and a crashed engine all resolve a
 * failure result, so a caller never has to try/catch a refresh away.
 *
 * Also like p4Service, a `.mjs`/`.js`/`.cjs` executable is run through the
 * current Node runtime (`process.execPath <script>`, see
 * {@link p4deltaSpawnCommand}): the e2e fixture points the engine at a script,
 * and whether a shebang happens to be executable is not something a p4 argument
 * list should depend on.
 *
 * Where p4Service reads `-Mj` / `-ztag`, this one reads `--json`: stdout is then
 * JSON Lines only, one record per line dispatched on `kind`, the human-readable
 * report moves to stderr. That contract is `p4delta/docs/json-contract.md` (its
 * single source of truth); the readers built on it are in p4deltaParser.
 *
 * Two things this layer deliberately leaves to the caller:
 *  - it does not add `--json` (or any other flag) to `args` — the caller builds
 *    the whole argv. A run without `--json` yields zero JSON lines, which this
 *    layer reports as "no records, no summary", never as "clean";
 *  - it does not decide whether the session may use δ at all. When `p4` resolves
 *    to a `.mjs`/`.js` override, δ's own handoff calls would run the fake instead
 *    of a real p4, so an IMPLICIT session stays native; a call site that named
 *    both engines explicitly (the e2e fixture) keeps δ and passes `P4_EXE` down
 *    instead. Either way the service only merges the `extraEnv` it is handed (see
 *    {@link P4deltaRunOptions.extraEnv}).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ConcurrencyGate, P4Priority } from '../concurrency.js'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_P4_COMMAND_TIMEOUT_MS,
  type P4Connection,
} from '../p4Service.js'
import { activeManagedP4delta } from './p4deltaStore.js'

/** One parsed JSON line. Fields stay loose: the contract guarantees more than
 *  the readers assume, so every read validates (see p4deltaParser). */
export type P4deltaRecord = Record<string, unknown>

export interface P4deltaRunOptions {
  /**
   * Kill the child when it hasn't exited within this many ms (see the same
   * option on {@link P4ExecOptions} for why a stuck engine may not hold its
   * gate slot). `0` disarms the watchdog. Overrides the service default.
   */
  readonly timeoutMs?: number
  /** Kill the child when this signal aborts (user cancel). A command that
   *  already finished is unaffected; one that never started is never spawned. */
  readonly signal?: AbortSignal
  /**
   * Queue priority through the shared gate: `'interactive'` (a user click) may
   * use the reserved slot and skips ahead of `'background'` scans. Defaults to
   * background when omitted, exactly like P4Service.
   */
  readonly priority?: P4Priority
  /** Override the stdout byte cap ({@link DEFAULT_MAX_OUTPUT_BYTES}). */
  readonly maxOutputBytes?: number
  /**
   * Extra environment for the child, merged last (over the sanitized env and the
   * connection variables), so the caller can both add and override. Omitted here
   * when the service itself already carries some (see its constructor's
   * `extraEnv`): the per-run value wins.
   *
   * The caller decides the `P4_EXE` entry (the `p4` the engine hands files it
   * cannot digest over to): it may only be set when `p4` resolved to a real
   * binary, i.e. `resolveP4Command().prefixArgs` is empty. Under a `.mjs`
   * override that handoff would re-enter the fake p4 — unless the call site
   * configured BOTH engines explicitly (the e2e fixture does), which is the one
   * case where the override is passed through on purpose (see
   * `resolveP4deltaEngine`).
   */
  readonly extraEnv?: Readonly<Record<string, string>>
  /**
   * Every stdout record as it arrives, in order — the engine emits file records
   * per batch, so a long run reports its progress here rather than only at the
   * end. Consumer callbacks must not throw (host-crash red line 4), so this one
   * is called inside a try/catch like the log sink.
   */
  readonly onRecord?: (record: P4deltaRecord) => void
  /**
   * The spawned child's pid, once. Same purpose as the option of that name on
   * `P4ExecOptions`: the status bar samples the process tree's IO under it. The
   * tree is what matters, so a δ run qualifies — the `p4` children doing the
   * transfer hang off this pid.
   */
  readonly onSpawn?: (pid: number) => void
}

export interface P4deltaRunResult {
  /**
   * Exit code (0 success / 1 run error / 2 usage, same as the text mode). A
   * child killed by a signal has no code and is normalized to 1 — never treat
   * the code as the answer, `sawSummary` is what says whether there is one.
   */
  readonly code: number
  /**
   * Every JSON line stdout carried, in order — including kinds this layer does
   * not interpret (summary / unmatched / error / handoff). A killed run keeps
   * the records that already arrived: without a summary they are a partial
   * answer at best (contract hard rule 2).
   */
  readonly records: readonly P4deltaRecord[]
  /** `kind:"progress"` records scraped off stderr, in order. Progress display
   *  only — the contract forbids reading a conclusion out of them. */
  readonly progress: readonly P4deltaRecord[]
  /** Human-readable stderr lines (the report's text form under `--json`) for
   *  the Perforce output channel. */
  readonly log: readonly string[]
  /** A stdout line that was not a JSON object. The contract says this never
   *  happens, so it means the binary is not the engine we think it is — the
   *  consumer must not trust the run. */
  readonly sawNonJsonStdout: boolean
  /**
   * A `kind:"summary"` record appeared. This is the ONLY evidence that the run
   * reached a conclusion: a crash, a kill or a cancel leaves the stream without
   * one, and the caller must then fall back rather than read the partial
   * records as a complete (possibly empty) answer.
   */
  readonly sawSummary: boolean
  /** Signal that ended the child (watchdog kill, cancel, crash), or null when
   *  it exited on its own. Diagnostic only — see `sawSummary`. */
  readonly signal: string | null
}

/**
 * How `exe` must be spawned: the program plus the argv prefix that goes before
 * the engine's own arguments. Same rule and same reason as
 * `p4Service.resolveP4Command` — a `.mjs`/`.js`/`.cjs` override is not a native
 * executable, and the extension's own e2e fixture IS such a script, so it runs
 * through the current Node runtime instead. In the extension host that runtime
 * is Electron-as-node, which is why {@link envForSpawn} puts
 * ELECTRON_RUN_AS_NODE back into the sanitized env.
 */
export function p4deltaSpawnCommand(exe: string): {
  command: string
  prefixArgs: readonly string[]
} {
  if (/\.[mc]?js$/.test(exe)) return { command: process.execPath, prefixArgs: [exe] }
  return { command: exe, prefixArgs: [] }
}

function envForSpawn(command: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // sanitizeEnv strips ELECTRON_RUN_AS_NODE (see its denylist); without it the
  // Electron binary would start a GUI app instead of running the script.
  if (command === process.execPath) base.ELECTRON_RUN_AS_NODE = '1'
  return base
}

/**
 * Where a resolved copy came from. The gate treats `env` / `configured`
 * differently from the rest: those two are an operator naming a binary, so a
 * refusal there must not silently fall through to another copy.
 */
export type P4deltaSource = 'env' | 'configured' | 'path' | 'localAppData' | 'managed'

export interface P4deltaCandidate {
  readonly exe: string
  readonly source: P4deltaSource
}

/**
 * The p4delta executable to spawn, or undefined when this machine has none.
 *
 * Order — self-installed copies first, the editor's own copy last:
 * `UNIVERSE_P4DELTA_PATH` (the e2e / escape-hatch override, mirroring
 * `UNIVERSE_P4_PATH`), then the configured path, then `p4delta` on PATH, then
 * the Windows default install location, then the managed copy under
 * `managedRoot` (see p4deltaStore). A machine that already has its own δ keeps
 * using it; the managed one exists so that a machine without one still gets δ,
 * and it is only ever consulted when nothing else answered.
 *
 * A non-empty override is returned verbatim: a configured path that does not
 * exist has to surface as a refusal at the gate (one clear log line), not
 * silently fall through to some other copy of the binary. An empty string
 * counts as unset — that is the setting's default. The same rule applies to
 * `managedRoot`: absent or empty disables the managed tier entirely, and the
 * order is then byte-for-byte what it was before that tier existed.
 */
export function resolveP4deltaCommand(
  configuredPath?: string,
  managedRoot?: string,
): P4deltaCandidate | undefined {
  const override = process.env.UNIVERSE_P4DELTA_PATH
  if (override) return { exe: override, source: 'env' }
  if (configuredPath) return { exe: configuredPath, source: 'configured' }
  const exeName = process.platform === 'win32' ? 'p4delta.exe' : 'p4delta'
  const onPath = locateOnPath(exeName)
  if (onPath) return { exe: onPath, source: 'path' }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      const installed = join(localAppData, 'Programs', 'p4delta', 'p4delta.exe')
      if (existsSync(installed)) return { exe: installed, source: 'localAppData' }
    }
  }
  if (managedRoot !== undefined && managedRoot !== '') {
    const managed = activeManagedP4delta(managedRoot)
    if (managed !== undefined) return { exe: managed, source: 'managed' }
  }
  return undefined
}

/**
 * Whether the session named an engine explicitly — `UNIVERSE_P4DELTA_PATH` or a
 * non-empty `perforce.p4delta.path` — as opposed to the editor finding one.
 *
 * Two callers share this one predicate: the gate uses it for the p4-script
 * hedge (an explicitly named pair is the operator saying "these two are mine"),
 * and the installer uses it to stay out of the way (a named engine is a
 * deliberate choice, and downloading a second copy would be noise).
 */
export function p4deltaNamedExplicitly(configuredPath: string): boolean {
  return Boolean(process.env.UNIVERSE_P4DELTA_PATH) || configuredPath !== ''
}

function locateOnPath(exeName: string): string | undefined {
  const path = process.env.PATH
  if (!path) return undefined
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exeName)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Same denylist as p4Service's sanitizeEnv — see there for why `PWD` matters
 * (p4 resolves P4CONFIG by walking up from it, ignoring the process cwd, and
 * the engine spawns p4 itself for its handoffs). Deliberately a second copy:
 * this module keeps its own spawn plumbing, so a new entry has to be added in
 * both places.
 */
const ENV_DENYLIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
  'PWD',
]

function sanitizeEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_DENYLIST.includes(k)) continue
    out[k] = v
  }
  return out
}

const ARGV_LOG_MAX_CHARS = 500

function formatArgvForLog(args: readonly string[]): string {
  let out = ''
  for (let i = 0; i < args.length; i++) {
    const piece = i === 0 ? args[i]! : ` ${args[i]!}`
    if (out.length + piece.length > ARGV_LOG_MAX_CHARS) {
      const room = ARGV_LOG_MAX_CHARS - out.length
      return `${room > 0 ? out + piece.slice(0, room) : out}… (${args.length} args)`
    }
    out += piece
  }
  return out
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code = (err as NodeJS.ErrnoException).code
  return code ? `${code} — ${err.message}` : err.message
}

function killQuietly(proc: { kill: () => unknown }): void {
  try {
    proc.kill()
  } catch {
    // Already gone — the close handler resolves the result either way.
  }
}

function parseJsonLine(line: string): P4deltaRecord | undefined {
  try {
    const value = JSON.parse(line) as unknown
    // A JSON Lines record is an object; any other JSON value is not one.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as P4deltaRecord
    }
  } catch {
    // Not JSON — the caller decides what that means.
  }
  return undefined
}

/**
 * A bound p4delta command runner: carries the connection, cwd, concurrency gate
 * and optional log so callers just pass the subcommand args. Built per client,
 * next to its {@link P4Service}, once the gate admitted an executable.
 */
export class P4deltaService {
  /**
   * `exe` and `clientRoot` belong to the caller: it passes `--client-root` and
   * `toReconcileFiles` the same values this service was built with.
   *
   * `defaultTimeoutMs` defaults to the same 600s constant P4Service uses but
   * does NOT follow `setP4CommandTimeoutSeconds` — that module default is
   * private to p4Service, so the caller wires `perforce.commandTimeout` through
   * this parameter (as it already does when building its P4Service).
   *
   * `extraEnv` is the environment EVERY run of this service carries (the session
   * -wide half of {@link P4deltaRunOptions.extraEnv}); the caller uses it for
   * `P4_EXE`, which is a property of the engine, not of one invocation.
   */
  constructor(
    private readonly _cwd: string,
    private readonly _gate: ConcurrencyGate,
    private readonly _connection: P4Connection | undefined,
    readonly exe: string,
    readonly clientRoot: string,
    private readonly _log?: (msg: string) => void,
    private readonly _defaultTimeoutMs: number = DEFAULT_P4_COMMAND_TIMEOUT_MS,
    private readonly _extraEnv: Readonly<Record<string, string>> = {},
  ) {}

  /**
   * Run `<exe> <args>` and resolve with the parsed record stream. `args` is the
   * complete argv (`--json`, `--client-root <root>`, the mode subcommand, the
   * scope) — nothing is added here. Never rejects.
   */
  run(args: readonly string[], options?: P4deltaRunOptions): Promise<P4deltaRunResult> {
    return this._gate.run(
      () => this._spawn(args, options),
      options?.priority,
      (waitedMs) => {
        if (waitedMs < 250) return
        this._logSafe(`  (queued ${waitedMs}ms for a concurrency slot)`)
      },
    )
  }

  /**
   * Async-callback-safe logging: the data/close/watchdog handlers MUST NOT throw
   * (host-crash red line 4) and the log sink is caller code, so it gets the same
   * treatment as a consumer callback.
   */
  private _logSafe(message: string): void {
    try {
      this._log?.(message)
    } catch {
      // best-effort
    }
  }

  /**
   * The child env: sanitized, then the connection coordinates as the P4*
   * variables the engine reads (p4 itself gets them as `-c/-u/-p` flags).
   * `P4CLIENT`/`P4USER` overwrite whatever the parent shell exported — the
   * discovered connection is the truth every other command in this session runs
   * against. `P4PORT` goes out ONLY when the connection carries an explicitly
   * configured port (red line 2: never derived from what the server reports).
   */
  private _childEnv(options?: P4deltaRunOptions): NodeJS.ProcessEnv {
    const env = sanitizeEnv()
    const conn = this._connection
    if (conn?.client) env.P4CLIENT = conn.client
    if (conn?.user) env.P4USER = conn.user
    if (conn?.port) env.P4PORT = conn.port
    for (const [key, value] of Object.entries(this._extraEnv)) env[key] = value
    for (const [key, value] of Object.entries(options?.extraEnv ?? {})) env[key] = value
    return env
  }

  private _spawn(args: readonly string[], options?: P4deltaRunOptions): Promise<P4deltaRunResult> {
    return new Promise<P4deltaRunResult>((resolve) => {
      const start = Date.now()
      const timeoutMs = options?.timeoutMs ?? this._defaultTimeoutMs
      const maxBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      const records: P4deltaRecord[] = []
      const progress: P4deltaRecord[] = []
      const log: string[] = []
      let sawNonJsonStdout = false
      let nonJsonStdoutLines = 0
      let stdoutBytes = 0
      let overflowed = false
      let cancelled = false
      let timedOut = false

      this._logSafe(`> p4delta ${formatArgvForLog(args)}`)

      const note = (message: string): void => {
        log.push(message)
        this._logSafe(`  ${message}`)
      }

      const finish = (code: number, signal: string | null): void => {
        const elapsed = Date.now() - start
        this._logSafe(
          `  exit ${code} (${elapsed}ms, ${records.length} record(s), ${progress.length} progress, ` +
            `${nonJsonStdoutLines} non-JSON stdout line(s)${signal ? `, signal ${signal}` : ''})`,
        )
        resolve({
          code,
          records,
          progress,
          log,
          sawNonJsonStdout,
          sawSummary: records.some((r) => r['kind'] === 'summary'),
          signal,
        })
      }

      const readStdoutLine = (line: string): void => {
        const record = parseJsonLine(line)
        if (record !== undefined) {
          records.push(record)
          // The consumer's callback is caller code running from a data handler:
          // it gets the same treatment as the log sink (host-crash red line 4).
          try {
            options?.onRecord?.(record)
          } catch {
            // best-effort
          }
          return
        }
        sawNonJsonStdout = true
        nonJsonStdoutLines += 1
        if (nonJsonStdoutLines === 1) {
          // The contract says stdout is JSON Lines only, so a stray line means
          // the binary is not the engine we think it is. One sample diagnoses
          // it; warning on every line would bury the report it is part of.
          this._logSafe(`  non-JSON stdout line (engine mismatch?): ${truncate(line, 200)}`)
        }
      }

      // stderr carries the human-readable report under `--json`, with the
      // progress records riding along — everything else is a log line.
      const readStderrLine = (line: string): void => {
        const record = parseJsonLine(line)
        if (record !== undefined && record['kind'] === 'progress') progress.push(record)
        else log.push(line)
      }

      let proc
      try {
        const { command, prefixArgs } = p4deltaSpawnCommand(this.exe)
        proc = spawn(command, [...prefixArgs, ...args], {
          cwd: this._cwd,
          env: envForSpawn(command, this._childEnv(options)),
          windowsHide: true,
          shell: false,
        })
      } catch (err) {
        // Synchronous spawn throw (bad options, ENAMETOOLONG argv): a failure
        // result, never a rejection — the caller has no try/catch around a
        // background refresh.
        note(`p4delta spawn failed: ${describeError(err)}`)
        finish(1, null)
        return
      }

      const timer =
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              this._logSafe(`  p4delta ${args[0] ?? ''} timed out after ${timeoutMs}ms; killing`)
              killQuietly(proc)
            }, timeoutMs)
          : undefined
      timer?.unref?.()

      if (proc.pid !== undefined) {
        try {
          options?.onSpawn?.(proc.pid)
        } catch {
          // Same red line as onRecord: a sampler that throws must not take the
          // host down with it.
        }
      }

      const abortSignal = options?.signal
      const onAbort = (): void => {
        cancelled = true
        this._logSafe(`  p4delta ${args[0] ?? ''} cancelled; killing`)
        killQuietly(proc)
      }
      if (abortSignal) {
        if (abortSignal.aborted) onAbort()
        else abortSignal.addEventListener('abort', onAbort, { once: true })
      }
      const detachSignal = (): void => abortSignal?.removeEventListener('abort', onAbort)

      let stdoutCarry = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        if (overflowed) return
        stdoutBytes += chunk.length
        if (stdoutBytes > maxBytes) {
          // Same host-crash red line as p4Service's cap: abort instead of
          // accumulating toward a string V8 cannot build.
          overflowed = true
          stdoutCarry = ''
          killQuietly(proc)
          return
        }
        stdoutCarry += chunk.toString('utf8')
        const lines = stdoutCarry.split(/\r?\n/)
        stdoutCarry = lines.pop() ?? ''
        for (const line of lines) {
          if (line === '') continue
          readStdoutLine(line)
        }
      })

      let stderrCarry = ''
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrCarry += chunk.toString('utf8')
        const lines = stderrCarry.split(/\r?\n/)
        stderrCarry = lines.pop() ?? ''
        for (const line of lines) {
          if (line === '') continue
          readStderrLine(line)
        }
      })

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer)
        detachSignal()
        // ENOENT and friends: the engine may have been uninstalled mid-session.
        // Resolve a failure (empty stream, no summary) so the caller falls back.
        note(`p4delta spawn failed: ${describeError(err)}`)
        finish(1, null)
      })

      proc.on('close', (code, signal) => {
        if (timer) clearTimeout(timer)
        detachSignal()
        // A killed child never terminates its last line; flush what arrived so a
        // complete-but-unterminated record is not lost.
        if (stdoutCarry !== '') readStdoutLine(stdoutCarry)
        if (stderrCarry !== '') readStderrLine(stderrCarry)
        if (cancelled) note(`p4delta ${args[0] ?? ''} was cancelled`)
        else if (timedOut)
          note(`p4delta ${args[0] ?? ''} timed out after ${timeoutMs}ms and was killed`)
        else if (overflowed) {
          const mb = Math.round(maxBytes / (1024 * 1024))
          note(`p4delta ${args[0] ?? ''} output exceeded ${mb}MB and was aborted`)
        }
        // No code means no normal exit (killed / crashed) — 1 either way.
        finish(code ?? 1, signal ?? null)
      })
    })
  }
}
