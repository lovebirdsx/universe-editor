/**
 * Thin wrapper over the `p4` CLI. Every call is `spawn('p4', argv)` with an
 * argument array — never a shell string — so paths and messages can't inject
 * shell syntax. Global connection options (`-c client -u user -p port`) are
 * prepended from the resolved connection. The child env is sanitized the same
 * way gitService sanitizes git's: the ELECTRON_* / NODE_OPTIONS denylist is
 * stripped so a Node-shaped child can't be steered.
 *
 * Structured output goes through `-Mj` (JSON, cheapest) with a `-ztag` fallback
 * for servers/commands where JSON isn't available; both are parsed in p4Output.
 * `-G` (Python marshal) is intentionally not used.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcurrencyGate, P4Priority } from './concurrency.js'
import { parseMarshalJson, parseZtag, parseZtagAsMarshal, type P4Record } from './p4Output.js'

export interface P4ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  /**
   * Set only when the SpawnWatchdog killed the command. Callers that opt into
   * {@link P4ExecOptions.recoverPartialOnTimeout} recover the stdout the command
   * already streamed through that channel; `stdout` itself stays '' here.
   */
  readonly timedOut?: boolean
}

/** Connection coordinates prepended as global options to every command. */
export interface P4Connection {
  readonly port?: string
  readonly user?: string
  readonly client?: string
}

export interface P4ExecOptions {
  /** Written to the child's stdin then closed (login password, spec forms). */
  readonly input?: string
  /** Skip the connection global options (e.g. bare `p4 set` / `p4 info`). */
  readonly noConnection?: boolean
  /**
   * Drop only the client (`-c`) global while keeping `-p`/`-u`. A depot-syntax
   * read (`p4 print //depot/…#rev` or `…@=change`) is otherwise filtered through
   * the current client's view, so a file not mapped in that view prints empty —
   * which is exactly what an out-of-workspace Swarm diff hits. Without a client,
   * p4 has no view to filter against and the depot spec resolves unrestricted.
   */
  readonly noClient?: boolean
  /** Override the stdout byte cap ({@link DEFAULT_MAX_OUTPUT_BYTES}). */
  readonly maxOutputBytes?: number
  /**
   * Kill the child when it hasn't exited within this many ms, resolving a
   * failure result. Without it a hung p4 (frozen network-drive cwd, half-open
   * TCP to a P4P gateway) holds its ConcurrencyGate slot forever — and with it
   * every later command, including the Swarm credential lookups that gate all
   * Swarm HTTP (the 44-minute poll wedge). Overrides the service default.
   */
  readonly timeoutMs?: number
  /**
   * Kill the child when this signal aborts, resolving a failure result whose
   * stderr says the command was cancelled. Lets a user abandon a long operation
   * (the status-bar spinner offers this) instead of waiting out
   * `perforce.commandTimeout`. A command already finished when the signal fires is
   * unaffected; a command that never started is never spawned.
   */
  readonly signal?: AbortSignal
  /**
   * Queue priority: `'interactive'` (user-triggered) may use the gate's reserved
   * slot and skips ahead of `'background'` (scans/refreshes). Defaults to
   * background when omitted.
   */
  readonly priority?: P4Priority
  /**
   * Called once per complete stdout line as it arrives. Best-effort UI signal
   * only — the authoritative output is still the buffered result. A throwing
   * callback is swallowed and logged, never re-thrown, so it can't crash the
   * extension host from the async data/close handlers.
   */
  readonly onStdoutLine?: (line: string) => void
  /**
   * Opt-in recovery of the stdout a timed-out command already streamed: when set,
   * {@link execRecords} collects the complete lines as they arrive and, if the
   * watchdog kills the command, parses them as `records` (the result keeps
   * `timedOut` true so callers know it is partial). Only for "lower-bound of
   * drift found" consumers; callers that answer "which of these exactly?" must
   * NOT set it — a partial answer would pin the un-covered paths as clean.
   */
  readonly recoverPartialOnTimeout?: boolean
}

/**
 * Upper bound on a single command's stdout before we abort it. V8 caps a JS
 * string at ~512MB (0x1fffffe8); `Buffer.concat(...).toString()` past that
 * throws `Cannot create a string longer than ...`, which — thrown from the
 * async `close` handler with no try/catch — crashed the whole extension host.
 * We stop well below the limit (also bounding memory) and fail the command
 * gracefully instead. No real p4 read the editor consumes approaches this.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024

/**
 * Default lifetime of a single p4 process before it is killed. Bounds "hung
 * forever", not "slow": legit heavy commands (reconcile over a big folder on a
 * network drive, large submits) can take minutes, so the default stays generous
 * and is configurable via `perforce.commandTimeout` (seconds, 0 = no timeout).
 * Tiny read-only commands pass a much tighter per-call `timeoutMs`.
 */
export const DEFAULT_P4_COMMAND_TIMEOUT_MS = 600_000

/**
 * Byte cap on the text {@link execRecords} collects for partial-on-timeout
 * recovery. Bounding the string we build is the same host-crash red line as
 * {@link DEFAULT_MAX_OUTPUT_BYTES} (a string V8 can't allocate thrown from the
 * async data/close handler takes the whole host down), applied to the streamed
 * recovery channel instead of the main buffer. Exported so tests exercise the
 * truncation path with a small value.
 */
export const RECOVER_PARTIAL_TIMEOUT_MAX_BYTES = 32 * 1024 * 1024

/** A bounded per-line collector for partial-on-timeout recovery (see
 *  {@link RECOVER_PARTIAL_TIMEOUT_MAX_BYTES}). `onLine` never throws — it runs
 *  inside `_spawn`'s async data/close handlers (host-crash red line). */
export function createRecoverLineCollector(
  maxBytes: number,
  log: (msg: string) => void,
): { onLine: (line: string) => void; text: () => string } {
  let text = ''
  let bytes = 0
  let stopped = false
  const onLine = (line: string): void => {
    if (stopped) return
    const chunk = line + '\n'
    const chunkBytes = Buffer.byteLength(chunk)
    if (bytes + chunkBytes > maxBytes) {
      // Keep what we already have and stop — never silently drop later lines.
      stopped = true
      log(`  partial stdout recovery truncated at ${maxBytes} bytes; keeping ${bytes} bytes`)
      return
    }
    bytes += chunkBytes
    text += chunk
  }
  return { onLine, text: () => text }
}

/**
 * Tight per-command timeout for user-interactive reads (open diff / dirty-diff
 * gutter / blame / timeline). The 600s default guards against "hung forever";
 * an interactive command that can't answer in this window should fail fast with
 * a toast instead of leaving the user staring at a dead UI.
 */
export const INTERACTIVE_COMMAND_TIMEOUT_MS = 30_000

/** Shared options for user-interactive p4 reads: the gate's reserved slot plus a
 *  tight timeout. Callers that need their own extras spread and merge (e.g. a
 *  `noClient` depot-syntax print). */
export const INTERACTIVE_EXEC: P4ExecOptions = {
  priority: 'interactive',
  timeoutMs: INTERACTIVE_COMMAND_TIMEOUT_MS,
}

/**
 * Interactive priority *without* the tight timeout, for reads whose duration
 * legitimately scales with payload size (`p4 print` streams whole file
 * contents). They still jump the gate's queue — but a 5MB file over a slow VPN
 * taking 40s is normal, not a hang, so they keep the generous
 * `perforce.commandTimeout` budget. Omitting `timeoutMs` falls back to the
 * service's default (`options?.timeoutMs ?? this._defaultTimeoutMs` in `_spawn`).
 */
export const INTERACTIVE_CONTENT_EXEC: P4ExecOptions = { priority: 'interactive' }

/** Module-level default applied to every new P4Service (set once at activate
 *  from `perforce.commandTimeout`; tests omit it and get the constant). */
let moduleDefaultTimeoutMs = DEFAULT_P4_COMMAND_TIMEOUT_MS

/** Apply the `perforce.commandTimeout` setting (seconds; 0 disables timeouts). */
export function setP4CommandTimeoutSeconds(seconds: number): void {
  moduleDefaultTimeoutMs =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : Infinity
}

/**
 * Shared spawn-timeout handling for {@link P4Service}: arms a timer that kills
 * the child on expiry and reports whether the close/error path should resolve a
 * timeout failure. `Infinity` (timeout disabled) arms nothing.
 */
class SpawnWatchdog {
  private _timedOut = false
  private readonly _timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    proc: { kill: () => unknown },
    private readonly _timeoutMs: number,
    private readonly _label: string,
    private readonly _log?: (msg: string) => void,
  ) {
    if (Number.isFinite(_timeoutMs) && _timeoutMs > 0) {
      this._timer = setTimeout(() => {
        this._timedOut = true
        this._log?.(`  ${this._label} timed out after ${this._timeoutMs}ms; killing`)
        proc.kill()
      }, _timeoutMs)
      // Never let a watchdog hold the host process open on its own.
      this._timer.unref?.()
    }
  }

  get timedOut(): boolean {
    return this._timedOut
  }

  /** Failure message once timed out (call from the close handler). */
  get message(): string {
    return `${this._label} timed out after ${this._timeoutMs}ms and was killed`
  }

  dispose(): void {
    if (this._timer) clearTimeout(this._timer)
  }
}

/**
 * Budget (in characters) for the variable path list of a single p4 command.
 * Windows caps a whole command line at 32767 chars; a p4 invocation also spends
 * some of that on the executable path, connection globals (`-p/-u/-c`) and the
 * fixed subcommand args, so we keep the path portion well under the limit. Used
 * both as the batch budget for read-path `chunkByLength` (`reconcile -n` /
 * `ignores` / `where`) and as the trigger for spawn-layer `-x` argfile on long
 * mutation argv (a 17k-file DEFAULT changelist otherwise blew `revert -k` /
 * `reopen` into `spawn ENAMETOOLONG`).
 */
export const MAX_PATH_ARGS_CHARS = 8000

/**
 * Split `items` into batches whose joined length (with one separator char per
 * item) stays within `maxChars`. A single item longer than the budget still
 * gets its own batch — a path can't be split, and one over-long path is rarer
 * (and less fatal) than a whole list blowing the command-line limit. Preserves
 * order; never emits an empty batch.
 */
export function chunkByLength(
  items: readonly string[],
  maxChars = MAX_PATH_ARGS_CHARS,
): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let currentLen = 0
  for (const item of items) {
    const cost = item.length + 1
    if (current.length > 0 && currentLen + cost > maxChars) {
      batches.push(current)
      current = []
      currentLen = 0
    }
    current.push(item)
    currentLen += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** Same rationale as the git spawner — see extensionHostMainService. */
const ENV_DENYLIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
  // p4 resolves P4CONFIG by walking up from `PWD` when that variable is set,
  // ignoring the process's actual working directory (verified on Windows: with
  // cwd inside one client's root but `PWD` pointing elsewhere, `p4 info` reports
  // a completely different client and root). This service deliberately spawns
  // with the client root as cwd so p4 resolves the right connection — a `PWD`
  // inherited from a msys/WSL parent shell would silently hijack that and every
  // command would run against the wrong client.
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

/**
 * On Windows, `spawn('p4', argv)` hands argv over as UTF-16 and p4.exe's CRT
 * re-encodes it via the system ANSI code page (GBK on zh-CN). With
 * `P4CHARSET=utf8` p4 expects UTF-8 instead, so any non-ASCII argument (a
 * Chinese depot path) arrives untranslatable — p4 exits 1 with "No Translation
 * for parameter" and reads like an empty file (the empty-Swarm-diff bug). The
 * same `-x <argfile>` hatch also dodges Windows' ~32767-char CreateProcess
 * limit, which a changelist of tens of thousands of ASCII paths otherwise
 * blows (`spawn ENAMETOOLONG` on `revert -k` / `reopen`).
 *
 * The cut is `min(first non-ASCII, first index over maxChars)` so a
 * 17k-file changelist that happens to contain one Chinese path still
 * gets a bounded command line, and that Chinese path still lands in the
 * UTF-8 argfile. `reason` is `'encoding'` when the cut is the first
 * non-ASCII argument, otherwise `'length'`. A single argument over
 * budget puts the whole argv in the file (`splitAt = 0`). p4 appends
 * file arguments after command-line ones, so order is preserved.
 * Returns undefined for short ASCII-only argv — the common case, which
 * must stay zero-cost.
 */
export function splitArgsForArgfile(
  args: readonly string[],
  maxChars = MAX_PATH_ARGS_CHARS,
): { argv: string[]; argfileLines: string[]; reason: 'encoding' | 'length' } | undefined {
  const nonAscii = /[^\x00-\x7f]/
  const firstNonAscii = args.findIndex((a) => nonAscii.test(a))
  const encodingAt = firstNonAscii >= 0 ? firstNonAscii : args.length
  let lengthAt = args.length
  let len = 0
  for (let i = 0; i < args.length; i++) {
    const cost = (args[i] ?? '').length + 1
    if (len + cost > maxChars) {
      lengthAt = i
      break
    }
    len += cost
  }
  const splitAt = Math.min(encodingAt, lengthAt)
  if (splitAt === args.length) return undefined
  const reason: 'encoding' | 'length' =
    encodingAt <= lengthAt && encodingAt < args.length ? 'encoding' : 'length'
  return { argv: args.slice(0, splitAt), argfileLines: args.slice(splitAt), reason }
}

const P4_ARGV_LOG_MAX_CHARS = 500

function formatP4ArgvForLog(args: readonly string[]): string {
  let out = ''
  for (let i = 0; i < args.length; i++) {
    const piece = i === 0 ? args[i]! : ` ${args[i]!}`
    if (out.length + piece.length > P4_ARGV_LOG_MAX_CHARS) {
      const room = P4_ARGV_LOG_MAX_CHARS - out.length
      const prefix = room > 0 ? out + piece.slice(0, room) : out
      return `${prefix}… (${args.length} args)`
    }
    out += piece
  }
  return out
}

function argvJoinedChars(args: readonly string[]): number {
  let n = 0
  for (const a of args) n += a.length + 1
  return n
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code
  }
  return undefined
}

function isArgvTooLongError(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'ENAMETOOLONG' || code === 'E2BIG'
}

function argvTooLongMessage(err: unknown): string {
  const code = errorCode(err) ?? 'ENAMETOOLONG'
  const detail = err instanceof Error ? err.message : String(err)
  return `p4 spawn failed: ${code} — command line too long (${detail})`
}

/**
 * Rewrite argv for spawning: non-ASCII or over-long arguments are written to
 * a UTF-8 temp argfile and replaced by a leading `-x <file>` (a global option,
 * valid before the other globals). Callers must invoke `cleanup` once the
 * child has closed. `error` set means the caller must not spawn — encoding
 * write failures still fall back to the original argv when it is short
 * enough (p4 then reports its own translation warning); once the original
 * argv is over budget (length cut, or encoding cut of an already-long
 * list) we must not fall back, because that spawn would ENAMETOOLONG.
 * Never throws from this path (extension-host crash red line).
 */
function prepareSpawnArgs(
  args: readonly string[],
  log?: (msg: string) => void,
): { args: readonly string[]; cleanup: () => void; error?: string } {
  const split = splitArgsForArgfile(args)
  if (!split) return { args, cleanup: () => {} }
  const argfile = join(tmpdir(), `universe-p4-args-${randomUUID()}.txt`)
  try {
    writeFileSync(argfile, split.argfileLines.join('\n') + '\n', 'utf8')
  } catch (err) {
    try {
      unlinkSync(argfile)
    } catch {
      // best-effort: write may have created a partial file
    }
    if (split.reason === 'length' || argvJoinedChars(args) > MAX_PATH_ARGS_CHARS) {
      const msg = `failed to write argfile for long argv (${(err as Error).message}); refusing to spawn an over-long command line`
      log?.(`  ${msg}`)
      return { args, cleanup: () => {}, error: msg }
    }
    log?.(
      `  failed to write argfile for non-ASCII args (${(err as Error).message}); passing argv as-is`,
    )
    return { args, cleanup: () => {} }
  }
  const via =
    split.reason === 'encoding' ? 'non-ASCII args via -x argfile' : 'long argv via -x argfile'
  log?.(`  (${via}: ${split.argfileLines.length} args)`)
  return {
    args: ['-x', argfile, ...split.argv],
    cleanup: () => {
      // Synchronous so callers observe the file gone as soon as the command
      // settles; never throws (called from async spawn handlers — red line).
      try {
        unlinkSync(argfile)
      } catch {
        // best-effort
      }
    },
  }
}

/**
 * The p4 executable to spawn. Defaults to `p4` (resolved from PATH), matching the
 * git extension's `spawn('git')`. `UNIVERSE_P4_PATH` overrides it — used by e2e to
 * point at a fake p4 (a Node script driven via `node <script>`), and available as
 * an escape hatch when `p4` isn't on PATH. When the override ends in `.mjs`/`.js`
 * /`.cjs` it's run through the current Node runtime (`process.execPath <script>`)
 * so the fake needs no executable bit / shebang and works identically on Windows.
 */
export function resolveP4Command(): { command: string; prefixArgs: readonly string[] } {
  const override = process.env.UNIVERSE_P4_PATH
  if (!override) return { command: 'p4', prefixArgs: [] }
  if (/\.[mc]?js$/.test(override)) return { command: process.execPath, prefixArgs: [override] }
  return { command: override, prefixArgs: [] }
}

/**
 * Whether `-Mj` output collapsed into data blobs instead of structured records.
 * Some servers emit report-style commands (`changes` / `describe` / `where`) as
 * one `{"data": "..."}` line per output line under `-Mj`, dropping the fields the
 * parsers need. Signature: at least one record, and every record carries `data`
 * (a real structured record never does). Empty output ("no files opened") is NOT
 * collapse — there's nothing to reshape, so the `-ztag` retry is skipped.
 */
export function isCollapsed(records: readonly Record<string, unknown>[]): boolean {
  return records.length > 0 && records.every((r) => 'data' in r)
}

/** Build the global connection options (`-c/-u/-p`) from a connection. When
 *  `dropClient` is set the `-c` client option is omitted (see {@link P4ExecOptions.noClient}). */
export function connectionArgs(conn: P4Connection | undefined, dropClient = false): string[] {
  if (!conn) return []
  const args: string[] = []
  if (conn.port) args.push('-p', conn.port)
  if (conn.user) args.push('-u', conn.user)
  if (conn.client && !dropClient) args.push('-c', conn.client)
  return args
}

/**
 * A bound p4 command runner: carries the connection, cwd, concurrency gate and
 * optional log so callers just pass the subcommand args. Created per client in
 * client.ts; `clientDiscovery` uses a connection-less instance for `p4 info`.
 */
export class P4Service {
  /**
   * Subcommands whose `-Mj` output collapsed into `{"data":…}` blobs on the
   * current connection, so later runs skip the wasted `-Mj` probe and go straight
   * to `-ztag`. Keyed by subcommand name — not global — because `fstat`/`opened`
   * stay structured on the very same server where `reconcile` collapses.
   */
  private readonly _collapsedSubcommands = new Set<string>()

  constructor(
    private readonly _cwd: string,
    private readonly _gate: ConcurrencyGate,
    private _connection: P4Connection | undefined,
    private readonly _log?: (msg: string) => void,
    private readonly _defaultTimeoutMs: number = moduleDefaultTimeoutMs,
  ) {}

  setConnection(conn: P4Connection | undefined): void {
    this._connection = conn
    // Collapse is a property of the server, not the p4 binary — a new connection
    // may answer `-Mj` normally, so memorized conclusions don't carry over.
    this._collapsedSubcommands.clear()
  }

  get connection(): P4Connection | undefined {
    return this._connection
  }

  /**
   * Record that `subcommand` collapses to `{"data":…}` blobs under `-Mj` — the
   * one place that conclusion is written, whether the probe finished or was
   * killed by the watchdog (a collapsed leg proves the server × subcommand
   * property no matter when it stopped).
   */
  private _rememberCollapse(
    subcommand: string | undefined,
    records: readonly Record<string, unknown>[],
  ): void {
    if (subcommand !== undefined && isCollapsed(records)) {
      this._collapsedSubcommands.add(subcommand)
    }
  }

  /** Run `p4 <args>` and resolve with stdout/stderr/exitCode (never rejects on a
   *  non-zero exit; rejects only if the process can't spawn — e.g. p4 missing.
   *  ENAMETOOLONG/E2BIG resolve as exit 1 rather than reject). */
  exec(args: readonly string[], options?: P4ExecOptions): Promise<P4ExecResult> {
    const globals = options?.noConnection ? [] : connectionArgs(this._connection, options?.noClient)
    const full = [...globals, ...args]
    return this._gate.run(
      () => this._spawn(full, options),
      options?.priority,
      (waitedMs) => {
        // A log write must never fail the command it describes — the gate now
        // surfaces a throwing onStart as a task rejection.
        if (waitedMs < 250) return
        try {
          this._log?.(`  (queued ${waitedMs}ms for a concurrency slot)`)
        } catch {
          // best-effort
        }
      },
    )
  }

  /** Run with `-Mj` and parse each JSON line. */
  async execJson(
    args: readonly string[],
    options?: P4ExecOptions,
  ): Promise<{ result: P4ExecResult; records: Record<string, unknown>[] }> {
    const result = await this.exec(['-Mj', ...args], options)
    return { result, records: parseMarshalJson(result.stdout) }
  }

  /**
   * Structured records for a report-style command, resilient to servers where
   * `-Mj` collapses output into `{"data": "..."}` blobs (see {@link isCollapsed}).
   * Runs `-Mj` first (cheapest); when the result carries structured fields it's
   * used as-is, but when it collapses to data blobs it re-runs the command with
   * `-ztag` and reshapes the tagged output into `-Mj`-compatible flat records so
   * the existing parsers consume it unchanged. On a normal server this costs the
   * same as {@link execJson} (no fallback spawn). A subcommand once observed to
   * collapse is remembered and skips the `-Mj` probe on later calls.
   */
  async execRecords(
    args: readonly string[],
    options?: P4ExecOptions,
  ): Promise<{ result: P4ExecResult; records: Record<string, unknown>[] }> {
    const sub = args[0]
    const subcommand = typeof sub === 'string' && !sub.startsWith('-') ? sub : undefined
    const recover = options?.recoverPartialOnTimeout === true
    const memorized = subcommand !== undefined && this._collapsedSubcommands.has(subcommand)
    if (!memorized) {
      const mj = await this._execRecordsLeg(['-Mj', ...args], options, recover)
      if (mj.result.timedOut && mj.collected.length > 0) {
        // A collapsed leg still proves the collapse even when the watchdog killed
        // it before it finished — remember it so the next call skips straight to
        // `-ztag` instead of re-paying the full `-Mj` timeout each time. Don't run
        // the `-ztag` retry here: that would double the worst case to two timeouts.
        const records = parseMarshalJson(mj.collected)
        this._rememberCollapse(subcommand, records)
        return { result: mj.result, records }
      }
      if (mj.result.exitCode !== 0)
        return { result: mj.result, records: parseMarshalJson(mj.result.stdout) }
      const records = parseMarshalJson(mj.result.stdout)
      if (!isCollapsed(records)) return { result: mj.result, records }
      this._rememberCollapse(subcommand, records)
      this._log?.(
        '  (-Mj collapsed to data blobs; retrying with -ztag, will skip -Mj for this subcommand)',
      )
    }
    const tagged = await this._execRecordsLeg(['-ztag', ...args], options, recover)
    if (tagged.result.timedOut && tagged.collected.length > 0) {
      return { result: tagged.result, records: parseZtagAsMarshal(tagged.collected) }
    }
    return { result: tagged.result, records: parseZtagAsMarshal(tagged.result.stdout) }
  }

  /**
   * One `execRecords` leg (`-Mj` or `-ztag`), optionally collecting the complete
   * lines the child streams so a watchdog kill can still surface them as partial
   * records. The collector is composed with any caller `onStdoutLine` (never
   * replaces it) and is reset per spawn — a fresh collector per leg keeps the
   * `-Mj` and `-ztag` outputs from mixing.
   */
  private async _execRecordsLeg(
    argv: readonly string[],
    options: P4ExecOptions | undefined,
    recover: boolean,
  ): Promise<{ result: P4ExecResult; collected: string }> {
    if (!recover) {
      return { result: await this.exec(argv, options), collected: '' }
    }
    const collector = createRecoverLineCollector(RECOVER_PARTIAL_TIMEOUT_MAX_BYTES, (msg) =>
      this._log?.(msg),
    )
    const userLine = options?.onStdoutLine
    const onStdoutLine = userLine
      ? (line: string): void => {
          collector.onLine(line)
          userLine(line)
        }
      : collector.onLine
    const result = await this.exec(argv, { ...options, onStdoutLine })
    return { result, collected: collector.text() }
  }

  /** Run with `-ztag` and parse into records (numbered keys collapsed). */
  async execTagged(
    args: readonly string[],
    options?: P4ExecOptions,
  ): Promise<{ result: P4ExecResult; records: P4Record[] }> {
    const result = await this.exec(['-ztag', ...args], options)
    return { result, records: parseZtag(result.stdout) }
  }

  /**
   * Run `p4 <args>` and resolve with stdout as raw bytes, for binary files (e.g.
   * `p4 print` of an xlsx) that UTF-8 decoding would corrupt. Same connection
   * globals + concurrency gate as {@link exec}; stderr decoded as text.
   */
  execBinary(
    args: readonly string[],
    options?: P4ExecOptions,
  ): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
    const globals = options?.noConnection ? [] : connectionArgs(this._connection, options?.noClient)
    const full = [...globals, ...args]
    return this._gate.run(
      () =>
        new Promise((resolve, reject) => {
          const { command, prefixArgs } = resolveP4Command()
          this._log?.(`> p4 ${formatP4ArgvForLog(full)} (binary)`)
          const env = sanitizeEnv()
          if (command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
          const prepared = prepareSpawnArgs(full, this._log)
          if (prepared.error !== undefined) {
            resolve({ stdout: Buffer.alloc(0), stderr: prepared.error, exitCode: 1 })
            return
          }
          let proc
          try {
            proc = spawn(command, [...prefixArgs, ...prepared.args], {
              cwd: this._cwd,
              env,
              windowsHide: true,
              shell: false,
            })
          } catch (err) {
            prepared.cleanup()
            if (isArgvTooLongError(err)) {
              const msg = argvTooLongMessage(err)
              this._log?.(`  ${msg}`)
              resolve({ stdout: Buffer.alloc(0), stderr: msg, exitCode: 1 })
              return
            }
            reject(err)
            return
          }
          const watchdog = new SpawnWatchdog(
            proc,
            options?.timeoutMs ?? this._defaultTimeoutMs,
            `p4 ${args[0] ?? ''}`,
            this._log,
          )
          const stdout: Buffer[] = []
          const stderr: Buffer[] = []
          proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
          proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
          proc.on('error', (err) => {
            watchdog.dispose()
            prepared.cleanup()
            if (isArgvTooLongError(err)) {
              const msg = argvTooLongMessage(err)
              this._log?.(`  ${msg}`)
              resolve({ stdout: Buffer.alloc(0), stderr: msg, exitCode: 1 })
              return
            }
            reject(err)
          })
          proc.on('close', (code) => {
            watchdog.dispose()
            prepared.cleanup()
            if (watchdog.timedOut) {
              resolve({ stdout: Buffer.alloc(0), stderr: watchdog.message, exitCode: code ?? 1 })
              return
            }
            resolve({
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr).toString('utf8'),
              exitCode: code ?? 0,
            })
          })
        }),
      options?.priority,
      (waitedMs) => {
        // A log write must never fail the command it describes — the gate now
        // surfaces a throwing onStart as a task rejection.
        if (waitedMs < 250) return
        try {
          this._log?.(`  (queued ${waitedMs}ms for a concurrency slot)`)
        } catch {
          // best-effort
        }
      },
    )
  }

  private _spawn(args: readonly string[], options?: P4ExecOptions): Promise<P4ExecResult> {
    return new Promise((resolve, reject) => {
      const { command, prefixArgs } = resolveP4Command()
      this._log?.(`> p4 ${formatP4ArgvForLog(args)}`)
      const start = Date.now()
      const env = sanitizeEnv()
      // When the fake p4 is a JS script we run it through this runtime. In the
      // extension host that runtime is Electron-as-node, and sanitizeEnv strips
      // ELECTRON_RUN_AS_NODE — re-add it so the child stays a Node process rather
      // than launching a full Electron app.
      if (command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
      const prepared = prepareSpawnArgs(args, this._log)
      if (prepared.error !== undefined) {
        resolve({ stdout: '', stderr: prepared.error, exitCode: 1 })
        return
      }
      let proc
      try {
        proc = spawn(command, [...prefixArgs, ...prepared.args], {
          cwd: this._cwd,
          env,
          windowsHide: true,
          shell: false,
        })
      } catch (err) {
        prepared.cleanup()
        if (isArgvTooLongError(err)) {
          const msg = argvTooLongMessage(err)
          this._log?.(`  ${msg}`)
          resolve({ stdout: '', stderr: msg, exitCode: 1 })
          return
        }
        reject(err)
        return
      }
      const maxBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      const watchdog = new SpawnWatchdog(
        proc,
        options?.timeoutMs ?? this._defaultTimeoutMs,
        `p4 ${args[0] ?? ''}`,
        this._log,
      )
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let overflowed = false
      // Per-line stdout streaming for progress UI. Best-effort only: the buffered
      // result stays authoritative. `carry` holds the bytes since the last newline
      // so a line split across chunks isn't emitted until it completes.
      const onStdoutLine = options?.onStdoutLine
      let carry = ''
      // Cancellation: kill the child and remember why, so `close` can resolve a
      // cancelled failure instead of a confusing "killed with no output" result.
      // Same red line as the watchdog — this callback is async, so it never throws.
      let cancelled = false
      const signal = options?.signal
      const onAbort = (): void => {
        cancelled = true
        this._log?.(`  p4 ${args[0] ?? ''} cancelled; killing`)
        proc.kill()
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      const detachSignal = (): void => signal?.removeEventListener('abort', onAbort)
      proc.stdout.on('data', (chunk: Buffer) => {
        if (overflowed) return
        stdoutBytes += chunk.length
        if (stdoutBytes > maxBytes) {
          // Abort rather than accumulate into a string V8 can't build. Kill the
          // child so p4 stops streaming; the `close` handler resolves the error.
          overflowed = true
          stdout.length = 0
          carry = ''
          proc.kill()
          return
        }
        stdout.push(chunk)
        if (onStdoutLine) {
          carry += chunk.toString('utf8')
          const lines = carry.split(/\r?\n/)
          carry = lines.pop() ?? ''
          for (const line of lines) {
            if (line === '') continue
            try {
              onStdoutLine(line)
            } catch (err) {
              // Async data handler — a throwing consumer must never escape into
              // an uncaught exception (host-crash red line). Log and move on.
              this._log?.(`  onStdoutLine callback threw: ${(err as Error).message}`)
            }
          }
        }
      })
      proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      proc.on('error', (err) => {
        watchdog.dispose()
        detachSignal()
        prepared.cleanup()
        if (isArgvTooLongError(err)) {
          const msg = argvTooLongMessage(err)
          this._log?.(`  ${msg}`)
          resolve({ stdout: '', stderr: msg, exitCode: 1 })
          return
        }
        reject(err)
      })
      proc.on('close', (code) => {
        watchdog.dispose()
        detachSignal()
        prepared.cleanup()
        if (cancelled) {
          const msg = `p4 ${args[0] ?? ''} was cancelled`
          resolve({ stdout: '', stderr: msg, exitCode: code ?? 1 })
          return
        }
        if (watchdog.timedOut) {
          // The watchdog already logged the kill; resolve a failure result so a
          // hung command fails loudly instead of wedging its gate slot forever.
          // `timedOut` marks the result for callers that recover partial output —
          // the buffered stdout is still discarded (that stays the global
          // semantic; partial results come through the streaming channel).
          resolve({ stdout: '', stderr: watchdog.message, exitCode: code ?? 1, timedOut: true })
          return
        }
        if (overflowed) {
          const mb = Math.round(maxBytes / (1024 * 1024))
          const msg = `p4 ${args[0] ?? ''} output exceeded ${mb}MB and was aborted`
          this._log?.(`  ${msg}`)
          resolve({ stdout: '', stderr: msg, exitCode: code ?? 1 })
          return
        }
        if (onStdoutLine && carry !== '') {
          try {
            onStdoutLine(carry)
          } catch (err) {
            // Same red line: the async close handler must never let a throwing
            // consumer escape into an uncaught exception.
            this._log?.(`  onStdoutLine callback threw: ${(err as Error).message}`)
          }
        }
        let result: P4ExecResult
        try {
          result = {
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode: code ?? 0,
          }
        } catch (err) {
          // Defensive: even under the cap, decoding can still throw on pathological
          // input. Never let it escape into an uncaught exception (host crash).
          const msg = `p4 ${args[0] ?? ''} output could not be decoded: ${(err as Error).message}`
          this._log?.(`  ${msg}`)
          resolve({ stdout: '', stderr: msg, exitCode: code ?? 1 })
          return
        }
        const elapsed = Date.now() - start
        const stderrNote = result.stderr.trim() ? `\n  stderr: ${result.stderr.trim()}` : ''
        this._log?.(`  exit ${result.exitCode} (${elapsed}ms)${stderrNote}`)
        resolve(result)
      })
      if (options?.input !== undefined) {
        proc.stdin.end(options.input)
      }
    })
  }
}
