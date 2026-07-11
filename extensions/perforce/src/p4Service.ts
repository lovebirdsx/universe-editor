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
import type { ConcurrencyGate } from './concurrency.js'
import { parseMarshalJson, parseZtag, parseZtagAsMarshal, type P4Record } from './p4Output.js'

export interface P4ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
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
  /** Override the stdout byte cap ({@link DEFAULT_MAX_OUTPUT_BYTES}). */
  readonly maxOutputBytes?: number
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

/** Same rationale as the git spawner — see extensionHostMainService. */
const ENV_DENYLIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
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

/** Build the global connection options (`-c/-u/-p`) from a connection. */
export function connectionArgs(conn: P4Connection | undefined): string[] {
  if (!conn) return []
  const args: string[] = []
  if (conn.port) args.push('-p', conn.port)
  if (conn.user) args.push('-u', conn.user)
  if (conn.client) args.push('-c', conn.client)
  return args
}

/**
 * A bound p4 command runner: carries the connection, cwd, concurrency gate and
 * optional log so callers just pass the subcommand args. Created per client in
 * client.ts; `clientDiscovery` uses a connection-less instance for `p4 info`.
 */
export class P4Service {
  constructor(
    private readonly _cwd: string,
    private readonly _gate: ConcurrencyGate,
    private _connection: P4Connection | undefined,
    private readonly _log?: (msg: string) => void,
  ) {}

  setConnection(conn: P4Connection | undefined): void {
    this._connection = conn
  }

  get connection(): P4Connection | undefined {
    return this._connection
  }

  /** Run `p4 <args>` and resolve with stdout/stderr/exitCode (never rejects on a
   *  non-zero exit; rejects only if the process can't spawn — e.g. p4 missing). */
  exec(args: readonly string[], options?: P4ExecOptions): Promise<P4ExecResult> {
    const globals = options?.noConnection ? [] : connectionArgs(this._connection)
    const full = [...globals, ...args]
    return this._gate.run(() => this._spawn(full, options))
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
   * same as {@link execJson} (no fallback spawn).
   */
  async execRecords(
    args: readonly string[],
    options?: P4ExecOptions,
  ): Promise<{ result: P4ExecResult; records: Record<string, unknown>[] }> {
    const mj = await this.exec(['-Mj', ...args], options)
    if (mj.exitCode !== 0) return { result: mj, records: parseMarshalJson(mj.stdout) }
    const records = parseMarshalJson(mj.stdout)
    if (!isCollapsed(records)) return { result: mj, records }
    // `-Mj` collapsed to data blobs on this server — retry with tagged output.
    this._log?.('  (-Mj collapsed to data blobs; retrying with -ztag)')
    const tagged = await this.exec(['-ztag', ...args], options)
    if (tagged.exitCode !== 0) return { result: tagged, records: parseMarshalJson(tagged.stdout) }
    return { result: tagged, records: parseZtagAsMarshal(tagged.stdout) }
  }

  /** Run with `-ztag` and parse into records (numbered keys collapsed). */
  async execTagged(
    args: readonly string[],
    options?: P4ExecOptions,
  ): Promise<{ result: P4ExecResult; records: P4Record[] }> {
    const result = await this.exec(['-ztag', ...args], options)
    return { result, records: parseZtag(result.stdout) }
  }

  private _spawn(args: readonly string[], options?: P4ExecOptions): Promise<P4ExecResult> {
    return new Promise((resolve, reject) => {
      const { command, prefixArgs } = resolveP4Command()
      this._log?.(`> p4 ${args.join(' ')}`)
      const start = Date.now()
      const env = sanitizeEnv()
      // When the fake p4 is a JS script we run it through this runtime. In the
      // extension host that runtime is Electron-as-node, and sanitizeEnv strips
      // ELECTRON_RUN_AS_NODE — re-add it so the child stays a Node process rather
      // than launching a full Electron app.
      if (command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
      const proc = spawn(command, [...prefixArgs, ...args], {
        cwd: this._cwd,
        env,
        windowsHide: true,
        shell: false,
      })
      const maxBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let overflowed = false
      proc.stdout.on('data', (chunk: Buffer) => {
        if (overflowed) return
        stdoutBytes += chunk.length
        if (stdoutBytes > maxBytes) {
          // Abort rather than accumulate into a string V8 can't build. Kill the
          // child so p4 stops streaming; the `close` handler resolves the error.
          overflowed = true
          stdout.length = 0
          proc.kill()
          return
        }
        stdout.push(chunk)
      })
      proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (overflowed) {
          const mb = Math.round(maxBytes / (1024 * 1024))
          const msg = `p4 ${args[0] ?? ''} output exceeded ${mb}MB and was aborted`
          this._log?.(`  ${msg}`)
          resolve({ stdout: '', stderr: msg, exitCode: code ?? 1 })
          return
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
