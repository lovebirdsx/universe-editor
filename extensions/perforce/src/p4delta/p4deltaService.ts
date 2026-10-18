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
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ConcurrencyGate, P4Priority } from '../concurrency.js'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_P4_COMMAND_TIMEOUT_MS,
  type P4Connection,
} from '../p4Service.js'
import { nextP4deltaRunId } from './p4deltaRunLog.js'
import { activeManagedP4delta } from './p4deltaStore.js'
import {
  parseP4deltaVersionBanner,
  parseP4deltaVersionBannerStrict,
  type P4deltaVersion,
} from './p4deltaVersion.js'

/** One parsed JSON line. Fields stay loose: the contract guarantees more than
 *  the readers assume, so every read validates (see p4deltaParser). */
export type P4deltaRecord = Record<string, unknown>

/**
 * 一次运行是怎么结束的。**只有 `ok` 是「有结论」**（流里出现了合法的 summary）；其余每一档
 * 都是「这一跑没有答案」，调用方据 `sawSummary` 回退，日志里则如实记一个终态。
 */
export type P4deltaRunStatus =
  | 'ok'
  | 'no-summary'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'overflow'
  | 'spawn-failed'

/** 一次**真实执行尝试**的开始信息（spawn 之前，所以 spawn 失败也有一份）。 */
export interface P4deltaRunStart {
  readonly runId: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly exe: string
  readonly clientRoot: string
  /** 编辑器收到这次运行的墙钟时间（epoch ms）。 */
  readonly startedAt: number
}

/** 终态信息。`note` 是终态的一句话（取消 / 超时 / 超量 / 无 summary）。 */
export interface P4deltaRunEnd extends Omit<P4deltaRunStart, 'cwd' | 'clientRoot' | 'exe'> {
  readonly status: P4deltaRunStatus
  readonly code: number
  readonly signal: string | null
  readonly elapsedMs: number
  readonly records: number
  readonly progress: number
  readonly note?: string
  /**
   * 一次运行的**命令统计摘要**，供日志收尾以 footer 写出（正文预算用尽也留得住）。有界、预
   * 格式化、<= {@link SUMMARY_FOOTER_MAX_CHARS}：只摘 mode / ok / applied / total / counts /
   * elapsedMs / p4Calls / p4CallsByCommand——**不是 summary 记录的复读**（那条已经实时进了
   * 频道）。没有 summary 记录时缺席。
   */
  readonly summary?: string
}

/** 运行期间逐行接收的出口（已经是「时间戳 + 相对耗时 + runId + 正文」的成品行）。 */
export interface P4deltaLineSink {
  line(text: string): void
}

/**
 * δ 的日志落点。扩展宿主注入（频道 + 落盘），`P4deltaService` 只负责把行格式化好推过来——
 * 本目录不 import `@universe-editor/extension-api`（见本目录 CLAUDE.md），所以能力靠注入。
 *
 * 两个方法都**不得抛出**（它们跑在 data/close 回调里，是宿主崩溃红线的射程内）；服务侧另
 * 外套 try/catch，注入方出错不影响运行的解析与回退判定。
 */
export interface P4deltaLogSink {
  /** 一次真实尝试开始。返回 undefined = 这次不落行（例如没有存储目录）。 */
  open(info: P4deltaRunStart): P4deltaLineSink | undefined
  /** 一次尝试落定，每个 open 恰好一次。 */
  close(info: P4deltaRunEnd): void
}

/** 单行上限：超长残行不再累积（一条 64 KiB 的行不可能是一条记录）。 */
const MAX_LINE_CHARS = 64 * 1024

/**
 * 内存里保留的 stderr 尾部上限。`result.log` 供失败详情（`lastNonEmptyLine`）与拒绝行解析读，
 * 一次宽 get 的 stderr 报告有几千行，无界增长会一直挂到 run 结束。单行已由 reader 封顶，这里
 * 只保留**有界尾部**：最后的 200 行且 <= 128 KiB。逐行诊断**照旧实时送 sink**，砍的只是内存里
 * 那份事后回读。
 */
const MAX_LOG_TAIL_LINES = 200
const MAX_LOG_TAIL_BYTES = 128 * 1024

/** 终态 summary 摘要页脚的上限：一句话（多行也不是），绝不能把 64 KiB 的终态预留吃光。 */
const SUMMARY_FOOTER_MAX_CHARS = 8 * 1024

/**
 * 有界行尾：只保留最近若干行且不超过若干字节，超出按行从头部丢。用于 `P4deltaRunResult.log`，
 * 让「诊断留在内存里」这件事有上限。单行已经由 {@link createP4deltaLineReader} 封顶，所以这里
 * 不重复按字符切行。
 */
export class P4deltaLogTail {
  private _lines: string[] = []
  private _bytes = 0

  constructor(
    private readonly _maxLines: number = MAX_LOG_TAIL_LINES,
    private readonly _maxBytes: number = MAX_LOG_TAIL_BYTES,
  ) {}

  push(line: string): void {
    this._lines.push(line)
    this._bytes += Buffer.byteLength(line, 'utf8') + 1
    // 行数超限或字节超限都从头部丢；至少留一行，免得一次超长尾行把整条 tail 清空。
    while (
      this._lines.length > this._maxLines ||
      (this._bytes > this._maxBytes && this._lines.length > 1)
    ) {
      const dropped = this._lines.shift()
      if (dropped === undefined) break
      this._bytes -= Buffer.byteLength(dropped, 'utf8') + 1
    }
  }

  /** 当前尾部的一份快照（调用方读它，改不到内部状态）。 */
  snapshot(): readonly string[] {
    return [...this._lines]
  }

  get length(): number {
    return this._lines.length
  }
}

/**
 * 把 summary 记录压成一行**有界**的命令统计摘要（mode / ok / applied / total / counts /
 * elapsedMs / p4Calls / p4CallsByCommand）。字段逐个受控读取：不是数字/字符串就跳过，绝不让
 * 一条畸形记录把页脚撑爆（超长再截断到 {@link SUMMARY_FOOTER_MAX_CHARS}）。没有任何可摘字段
 * 时返回 undefined。
 */
export function formatP4deltaSummaryFooter(record: P4deltaRecord): string | undefined {
  const parts: string[] = []
  const mode = record['mode']
  if (typeof mode === 'string') parts.push(`mode=${mode}`)
  if (record['ok'] === true || record['ok'] === false) parts.push(`ok=${String(record['ok'])}`)
  if (record['applied'] === true) parts.push('applied=true')
  if (record['force'] === true) parts.push('force=true')
  const total = record['total']
  if (typeof total === 'number' && Number.isFinite(total)) parts.push(`total=${total}`)
  const elapsedMs = record['elapsedMs']
  if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs))
    parts.push(`elapsedMs=${elapsedMs}`)
  const p4Calls = record['p4Calls']
  if (typeof p4Calls === 'number' && Number.isFinite(p4Calls)) parts.push(`p4Calls=${p4Calls}`)
  const byCommand = formatCountPairs(record['p4CallsByCommand'])
  if (byCommand !== undefined) parts.push(`p4CallsByCommand=${byCommand}`)
  const counts = formatCountPairs(record['counts'])
  if (counts !== undefined) parts.push(`counts=${counts}`)
  if (parts.length === 0) return undefined
  return truncate(`# summary: ${parts.join(' ')}`, SUMMARY_FOOTER_MAX_CHARS)
}

/** `class → n` 小对象压成 `a 3 · b 2`（次数降序，同数按名）；空/畸形返回 undefined。 */
function formatCountPairs(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => (b[1] as number) - (a[1] as number) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${key} ${value}`)
  return entries.length > 0 ? entries.join(' · ') : undefined
}

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
  /**
   * Every `kind:"progress"` stderr record as it arrives, in order — the same
   * records `P4deltaRunResult.progress` collects for the post-run replay, but
   * live: a consumer showing "which phase is it in right now" cannot wait for
   * the run to end. Called inside a try/catch like `onRecord` (host-crash red
   * line 4).
   */
  readonly onProgress?: (record: P4deltaRecord) => void
}

export interface P4deltaRunResult {
  /**
   * This attempt's run id — the key its log file is named after, and what the
   * sync history stores so the run's log can be opened later. Generated per real
   * attempt (queued-then-aborted runs included), never reused.
   */
  readonly runId: string
  /** Wall clock when the attempt started (epoch ms). */
  readonly startedAt: number
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

/** `--version` 采样的默认超时：clap 的版本输出是毫秒级的事，卡住就是这份二进制有问题。 */
const VERSION_PROBE_TIMEOUT_MS = 5000
/** `--version` 的输出上限：答案是一行 banner，收满 4 KiB 就不再攒。 */
const VERSION_PROBE_MAX_CHARS = 4 * 1024

/**
 * 起一次 `--version` 并把原始输出带回来。诊断与准入共用这份采样，所以形状必须与真实运行
 * 一致（`p4deltaSpawnCommand` 的 `.mjs` 分支 + `envForSpawn`），e2e fixture 那种脚本引擎
 * 同样能被采样。永不 reject / 永不 throw：spawn 失败、超时、无输出，一律 resolve undefined。
 */
function runP4deltaVersionProbe(exe: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: string | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let proc
    try {
      // 脚本形态下必须自己确认文件在：`node <不存在的脚本> --version` 会把 `--version` 当成
      // node 自己的选项，答出 **node 的版本号**——一个看起来完全合理的错误答案。
      if (!existsSync(exe)) {
        settle(undefined)
        return
      }
      const { command, prefixArgs } = p4deltaSpawnCommand(exe)
      proc = spawn(command, [...prefixArgs, '--version'], {
        env: envForSpawn(command, sanitizeEnv()),
        windowsHide: true,
        shell: false,
      })
    } catch {
      settle(undefined)
      return
    }
    let out = ''
    const collect = (chunk: Buffer): void => {
      if (out.length >= VERSION_PROBE_MAX_CHARS) return
      out += chunk.toString('utf8')
    }
    proc.stdout?.on('data', collect)
    proc.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      killQuietly(proc)
      // 不依赖 kill 之后的 close（Windows 上未必立刻到）：超时就是没有答案。
      settle(undefined)
    }, timeoutMs)
    timer.unref?.()
    proc.on('error', () => {
      clearTimeout(timer)
      settle(undefined)
    })
    proc.on('close', () => {
      clearTimeout(timer)
      settle(out.slice(0, VERSION_PROBE_MAX_CHARS))
    })
  })
}

/**
 * 采样一份 δ 的 `--version`，回答「这个 exe 自报什么版本」。**诊断**（命令面板的
 * 「显示 p4delta 信息」）用宽松解析；引擎准入走 {@link probeP4deltaBuild} 的严格版。
 * 结果**不进 δ 的运行日志**——它不是一次业务运行。
 */
export async function probeP4deltaVersion(
  exe: string,
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Promise<string | undefined> {
  const out = await runP4deltaVersionProbe(exe, timeoutMs)
  return out === undefined ? undefined : parseP4deltaVersionBanner(out)
}

interface P4deltaBuildProbeEntry {
  /** `mtimeMs:size` of the file the verdict came from; undefined when it could not be stat'ed. */
  readonly fingerprint: string | undefined
  readonly verdict: Promise<P4deltaVersion | undefined>
}

/**
 * 准入 verdict 按 exe 路径缓存，并带上文件的 `mtimeMs:size`：同一个路径被换成另一份
 * 二进制（尤其是**降级**）时必须重新采样。一次 stat 失败（Windows 上 AV/句柄占用）不能
 * 读成「文件变了」，否则一次抖动会让同一个二进制被探测两次；但若当初就是 stat 失败、
 * 之后又能读到指纹，则重新采样一次，避免一次抖动粘住整个会话。
 */
const buildProbeCache = new Map<string, P4deltaBuildProbeEntry>()

/** 仅测试用。生产不需要清缓存：指纹变化会自己触发重新探测。 */
export function clearP4deltaBuildProbeCache(): void {
  buildProbeCache.clear()
}

function statFingerprint(exe: string): string | undefined {
  try {
    const stats = statSync(exe)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return undefined
  }
}

/**
 * 引擎准入探测：严格解析 `p4delta <semver>` banner，**fail-closed**——超时、spawn 失败、
 * 无输出、输出不是 p4delta banner，一律 undefined，调用方据此回退原生 p4。
 * 一个指纹至多 spawn 一次（文件被替换、或 stat 从失败恢复时重探；见 {@link buildProbeCache}）。
 */
export function probeP4deltaBuild(
  exe: string,
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Promise<P4deltaVersion | undefined> {
  const fingerprint = statFingerprint(exe)
  const cached = buildProbeCache.get(exe)
  if (cached !== undefined) {
    // A stat that failed BEFORE cannot rule out a replacement; re-probe once it
    // starts answering again. A stat that fails NOW is not read as a change —
    // one AV/handle blip must not spawn the binary twice.
    const replaced =
      fingerprint !== undefined &&
      (cached.fingerprint === undefined || fingerprint !== cached.fingerprint)
    if (!replaced) return cached.verdict
  }
  // 采样契约是永不 reject；catch 只是不让一个意外 reject 被缓存成后续调用的答案。
  const verdict = runP4deltaVersionProbe(exe, timeoutMs)
    .then((out) => (out === undefined ? undefined : parseP4deltaVersionBannerStrict(out)))
    .catch(() => undefined)
  buildProbeCache.set(exe, { fingerprint, verdict })
  return verdict
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
 * Order — the two copies an operator named, the one this editor manages, then
 * whatever the machine provides: `UNIVERSE_P4DELTA_PATH` (the e2e / escape-hatch
 * override, mirroring `UNIVERSE_P4_PATH`), then the configured path, then the
 * managed copy under `managedRoot` (see p4deltaStore), then `p4delta` on PATH,
 * then the Windows default install location.
 *
 * 托管副本压在 PATH / `%LOCALAPPDATA%` 之上：它是编辑器唯一能持续升级的那份，被机器上更旧的自装副本遮蔽就永远升不上去。
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
  if (managedRoot !== undefined && managedRoot !== '') {
    const managed = activeManagedP4delta(managedRoot)
    if (managed !== undefined) return { exe: managed, source: 'managed' }
  }
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

/**
 * 一行 argv，超长即截断并带上真实条目数。**受控**：调用方只递参数，密码/ticket 从不进 argv
 * （登录走 stdin），所以这里没有 redaction 可言；截断是为了不让一条宽范围的 get 把一行日志
 * 撑到几万字符。
 */
export function formatArgvForLog(args: readonly string[]): string {
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

/**
 * 单调时钟（毫秒）。行上的「运行相对耗时」必须来自它：墙钟会被系统对时往回拨，一段负的
 * 相对耗时比没有更糟。
 */
function monotonicMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/**
 * 本地时间的 ISO 8601（带显式时区偏移，如 `2026-10-15T12:34:56.789+08:00`）。
 * `toISOString()` 是 UTC（尾缀 `Z`）——时区信息在，但读日志的人得自己换算，所以这里按本地
 * 时间渲染并写出偏移量。
 */
export function isoTimestampLocal(ms: number): string {
  const d = new Date(ms)
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 一行诊断的成品前缀：接收时间 + 相对运行起点的耗时 + runId。 */
export function formatP4deltaLogStamp(
  runId: string,
  reachedAtMs: number,
  elapsedMs: number,
): string {
  return `${isoTimestampLocal(reachedAtMs)} +${(elapsedMs / 1000).toFixed(3)}s ${runId} `
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
 * A chunk-safe line reader for one child stream.
 *
 * Two things it exists for, both of which the previous inline
 * `chunk.toString('utf8').split(/\r?\n/)` got wrong:
 *
 * - **UTF-8 across chunk boundaries.** A chunk can end mid-codepoint; decoding it
 *   on its own yields replacement characters, and a Chinese file name arriving
 *   split in half renders as `��` in the log — the very thing these
 *   logs exist to make readable. `StringDecoder` holds the partial bytes over.
 * - **Bounded carry.** A child that emits a very long line (or never emits a
 *   newline at all) would otherwise grow this buffer without limit. Past
 *   {@link MAX_LINE_CHARS} the line's head is reported once and the rest of it is
 *   dropped until its newline arrives — a 64 KiB "line" is not a record anyway,
 *   and dropping it beats accumulating toward a string V8 cannot build. The cap
 *   applies to the SAME limit whether the overlong line arrived terminated or
 *   not: a chunk carrying `…long…\nnext` must not slip a whole 64 KiB+ line
 *   through just because its newline happened to be in the same chunk.
 *
 * Neither `onLine` throw nor `onLongLine` throw nor a decoder hiccup may escape:
 * this runs from a `data` handler (host-crash red line 4).
 */
export function createP4deltaLineReader(
  onLine: (line: string) => void,
  onLongLine: (preview: string) => void,
): { push(chunk: Buffer): void; flush(): void } {
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let skipping = false

  const emit = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') return
    try {
      onLine(line)
    } catch {
      // The consumer's callback is caller code — same red line as the log sink.
    }
  }

  // The one place an overlong line is reported: once per line, prefix only. Same
  // red line as `emit`, and it must not throw out of the data handler either.
  const reportLong = (preview: string): void => {
    try {
      onLongLine(preview)
    } catch {
      // Injected code.
    }
  }

  return {
    push(chunk: Buffer): void {
      let text = decoder.write(chunk)
      while (text !== '') {
        if (skipping) {
          const nl = text.indexOf('\n')
          if (nl < 0) return
          skipping = false
          text = text.slice(nl + 1)
          continue
        }
        const nl = text.indexOf('\n')
        if (nl < 0) {
          // No newline in the rest: accumulate, but bound the carry.
          carry += text
          if (carry.length > MAX_LINE_CHARS) {
            reportLong(carry.slice(0, MAX_LINE_CHARS))
            carry = ''
            skipping = true
          }
          return
        }
        const raw = carry + text.slice(0, nl)
        carry = ''
        text = text.slice(nl + 1)
        // A complete line is capped by the same rule as a residual one: report the
        // head once and drop the line (its body is not a record either).
        if (raw.length > MAX_LINE_CHARS) {
          reportLong(raw.slice(0, MAX_LINE_CHARS))
          continue
        }
        emit(raw)
      }
    },
    flush(): void {
      // A killed child never terminates its last line; flush what arrived so a
      // complete-but-unterminated record is not lost. `decoder.end()` also
      // releases a trailing partial codepoint, which then renders as the
      // replacement character — honest, since those bytes really are torn.
      const tail = carry + decoder.end()
      const wasSkipping = skipping
      carry = ''
      skipping = false
      if (tail === '' || wasSkipping) return
      if (tail.length > MAX_LINE_CHARS) {
        reportLong(tail.slice(0, MAX_LINE_CHARS))
        return
      }
      emit(tail)
    },
  }
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
   *
   * `logSink` 是这次运行的诊断出口（P4delta 频道 + 落盘），由扩展宿主注入。**没有 sink 时
   * 详细诊断退回 `_log`**（Perforce 频道）而不是凭空消失：注入方在测试里可以缺席，但
   * 「诊断丢了」不能是一种静默的失败模式。
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
    private readonly _sink?: P4deltaLogSink,
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
      const startedAt = Date.now()
      const monoStart = monotonicMs()
      // One id per REAL attempt, minted here rather than by the caller: the run
      // that never got to `engine.run` (the eligibility checks) is not a run, and
      // a caller-supplied id would be reused by the fallback that follows.
      const runId = nextP4deltaRunId(startedAt)
      const timeoutMs = options?.timeoutMs ?? this._defaultTimeoutMs
      const maxBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      const records: P4deltaRecord[] = []
      const progress: P4deltaRecord[] = []
      // 有界行尾：stderr 报告与终态 note 都进这里，供失败详情 / 拒绝行解析事后回读。逐行诊断
      // 照旧实时送 sink，这份只封顶内存。
      const logTail = new P4deltaLogTail()
      // 最后一条 summary 记录的**有界摘要**，收尾时作为 footer 写出（正文被截断也留得住）。
      let summaryFooter: string | undefined
      let sawNonJsonStdout = false
      let nonJsonStdoutLines = 0
      let stdoutBytes = 0
      let overflowed = false
      let cancelled = false
      let timedOut = false
      let finished = false
      let spawnFailure: string | undefined

      const command = args[0] ?? ''

      // The run's own outlet. Lines carry the receiving time (which is what the
      // editor observed — never dressed up as when the engine produced them), the
      // monotonic elapsed time, and the run id, so one file can be read without
      // cross-referencing anything else.
      const lineSink = this._openSink({
        runId,
        args,
        startedAt,
        cwd: this._cwd,
        exe: this.exe,
        clientRoot: this.clientRoot,
      })
      const detail = (text: string): void => {
        const stamped = formatP4deltaLogStamp(runId, Date.now(), monotonicMs() - monoStart) + text
        if (lineSink === undefined) {
          // No dedicated outlet configured: fall back to the channel we do have
          // rather than dropping diagnostics on the floor.
          this._logSafe(`  ${text}`)
          return
        }
        try {
          lineSink.line(stamped)
        } catch {
          // Injected code — same red line as the log sink.
        }
      }

      this._logSafe(`> p4delta ${formatArgvForLog(args)} [${runId}]`)

      const note = (message: string): void => {
        logTail.push(message)
        this._logSafe(`  ${message}`)
      }

      /**
       * The single settle point. `error` and `close` both end a run (a spawn
       * failure fires `error` and may still be followed by `close`), so without
       * the latch the sink would be closed twice and the promise resolved twice —
       * a second resolve is a no-op, but a second `close` would truncate the log
       * file's footer and rewrite its rename.
       */
      const finish = (code: number, signal: string | null): void => {
        if (finished) return
        finished = true
        const elapsed = Date.now() - startedAt
        const sawSummary = records.some((r) => r['kind'] === 'summary')
        this._logSafe(
          `  exit ${code} (${elapsed}ms, ${records.length} record(s), ${progress.length} progress, ` +
            `${nonJsonStdoutLines} non-JSON stdout line(s)${signal ? `, signal ${signal}` : ''}) ` +
            `[${runId}]`,
        )
        const status = this._runStatus({
          cancelled,
          timedOut,
          overflowed,
          spawnFailure,
          sawSummary,
          code,
        })
        this._closeSink({
          runId,
          args,
          startedAt,
          status,
          code,
          signal,
          elapsedMs: elapsed,
          records: records.length,
          progress: progress.length,
          note: this._statusNote(status, {
            spawnFailure,
            timeoutMs,
            maxBytes,
            code,
          }),
          ...(summaryFooter !== undefined ? { summary: summaryFooter } : {}),
        })
        resolve({
          runId,
          startedAt,
          code,
          records,
          progress,
          log: logTail.snapshot(),
          sawNonJsonStdout,
          sawSummary,
          signal,
        })
      }

      const readStdoutLine = (line: string): void => {
        const record = parseJsonLine(line)
        if (record !== undefined) {
          records.push(record)
          const kind = record['kind']
          // 每条 summary 都重算一次有界摘要（最后一条赢，同 summarizeRun 的规则）：它作为收尾
          // footer 写出，正文预算用尽也留得住命令统计。
          if (kind === 'summary') summaryFooter = formatP4deltaSummaryFooter(record)
          // Per-file records and the per-call counter events are the two kinds
          // that would turn one wide get into tens of thousands of log lines.
          // Everything else (summary / error / unmatched / handoff) is diagnosis
          // worth keeping.
          if (kind !== 'file' && kind !== 'p4CommandCount') detail(JSON.stringify(record))
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
          detail(`non-JSON stdout line (engine mismatch?): ${truncate(line, 200)}`)
        }
      }

      // stderr carries the human-readable report under `--json`, with the
      // progress records riding along — everything else is a log line.
      const readStderrLine = (line: string): void => {
        const record = parseJsonLine(line)
        if (record !== undefined && record['kind'] === 'progress') {
          progress.push(record)
          // Structured progress is what a later reader can still make sense of
          // (phase / step / total); the raw JSON is kept verbatim, not reworded.
          detail(JSON.stringify(record))
          // The collected array only serves the replay after the run; a live
          // consumer reads the record here. Same red line as onRecord.
          try {
            options?.onProgress?.(record)
          } catch {
            // best-effort
          }
          return
        }
        logTail.push(line)
        detail(line)
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
        spawnFailure = describeError(err)
        note(`p4delta spawn failed: ${spawnFailure}`)
        finish(1, null)
        return
      }

      const timer =
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              this._logSafe(`  p4delta ${command} timed out after ${timeoutMs}ms; killing`)
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
        this._logSafe(`  p4delta ${command} cancelled; killing`)
        killQuietly(proc)
      }
      if (abortSignal) {
        if (abortSignal.aborted) onAbort()
        else abortSignal.addEventListener('abort', onAbort, { once: true })
      }
      const detachSignal = (): void => abortSignal?.removeEventListener('abort', onAbort)

      // stdout 的溢出残片是半个 JSON，抄前 200 字符只会往日志里灌噪声；stderr 的那条
      // 是给人读的，所以只有它带 preview。
      const stdoutReader = createP4deltaLineReader(readStdoutLine, () =>
        detail(`stdout line exceeds ${MAX_LINE_CHARS} chars; dropping the rest of it`),
      )
      proc.stdout.on('data', (chunk: Buffer) => {
        if (overflowed) return
        stdoutBytes += chunk.length
        if (stdoutBytes > maxBytes) {
          // Same host-crash red line as p4Service's cap: abort instead of
          // accumulating toward a string V8 cannot build.
          overflowed = true
          killQuietly(proc)
          return
        }
        stdoutReader.push(chunk)
      })

      const stderrReader = createP4deltaLineReader(readStderrLine, (preview) =>
        detail(
          `stderr line exceeds ${MAX_LINE_CHARS} chars; dropping the rest of it: ${truncate(preview, 200)}`,
        ),
      )
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrReader.push(chunk)
      })

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer)
        detachSignal()
        // ENOENT and friends: the engine may have been uninstalled mid-session.
        // Resolve a failure (empty stream, no summary) so the caller falls back.
        spawnFailure = describeError(err)
        note(`p4delta spawn failed: ${spawnFailure}`)
        finish(1, null)
      })

      proc.on('close', (code, signal) => {
        if (timer) clearTimeout(timer)
        detachSignal()
        // Flush what arrived before the child went away; a killed child never
        // terminates its last line (see the reader's own note).
        stdoutReader.flush()
        stderrReader.flush()
        if (cancelled) note(`p4delta ${command} was cancelled`)
        else if (timedOut) note(`p4delta ${command} timed out after ${timeoutMs}ms and was killed`)
        else if (overflowed) {
          const mb = Math.round(maxBytes / (1024 * 1024))
          note(`p4delta ${command} output exceeded ${mb}MB and was aborted`)
        }
        // No code means no normal exit (killed / crashed) — 1 either way.
        finish(code ?? 1, signal ?? null)
      })
    })
  }

  /**
   * Classify the terminal state. Precedence is the order in which the facts
   * became true, not a severity: an aborted run is a cancel even if it also
   * exited nonzero, and a stream without a summary is `no-summary` **even when
   * the exit code was 0** — the code is not the answer (contract hard rule 1).
   */
  private _runStatus(facts: {
    cancelled: boolean
    timedOut: boolean
    overflowed: boolean
    spawnFailure: string | undefined
    sawSummary: boolean
    code: number
  }): P4deltaRunStatus {
    if (facts.cancelled) return 'cancelled'
    if (facts.timedOut) return 'timeout'
    if (facts.overflowed) return 'overflow'
    if (facts.spawnFailure !== undefined) return 'spawn-failed'
    if (facts.sawSummary) return 'ok'
    return facts.code === 0 ? 'no-summary' : 'failed'
  }

  /** The terminal state in words — what the run log's footer and the channel summary say. */
  private _statusNote(
    status: P4deltaRunStatus,
    facts: { spawnFailure: string | undefined; timeoutMs: number; maxBytes: number; code: number },
  ): string {
    switch (status) {
      case 'ok':
        return 'concluded (summary received)'
      case 'no-summary':
        return 'exited 0 with no summary record — no conclusion'
      case 'failed':
        return `exit ${facts.code} without a summary record — no conclusion`
      case 'cancelled':
        return 'cancelled by the user'
      case 'timeout':
        return `timed out after ${facts.timeoutMs}ms and was killed`
      case 'overflow':
        return `output exceeded ${Math.round(facts.maxBytes / (1024 * 1024))}MB and was aborted`
      default:
        return `spawn failed: ${facts.spawnFailure ?? 'unknown error'}`
    }
  }

  /** Open the injected sink; a throwing sink is a sink we do not have. */
  private _openSink(info: P4deltaRunStart): P4deltaLineSink | undefined {
    try {
      return this._sink?.open(info) ?? undefined
    } catch {
      return undefined
    }
  }

  private _closeSink(info: P4deltaRunEnd): void {
    try {
      this._sink?.close(info)
    } catch {
      // Same red line: the sink is injected code running from a close handler.
    }
  }
}
