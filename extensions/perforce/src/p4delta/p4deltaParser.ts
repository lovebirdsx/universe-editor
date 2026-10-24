/**
 * Pure readers for the records a `p4delta --json` run emits. No I/O: the service
 * spawns and streams the lines, this module shapes them into the models the rest
 * of the extension already consumes. The contract is
 * `p4delta/docs/json-contract.md` — the single source of truth for every field
 * read here.
 *
 * The rule that must survive any refactor: a record stream without a
 * `kind:"summary"` record has NO conclusion. {@link summarizeRun} returns
 * undefined for such a stream, and every caller reads that as "no answer — ask
 * the other engine", never as "nothing to report".
 */
import type { P4Action } from '../changelist.js'
import type { P4deltaRecord, P4deltaRunResult } from './p4deltaService.js'
import { clientToLocalPath } from '../pathUtil.js'
import type { ReconcileFile } from '../reconcileParser.js'
import { REFUSED_DELETE_ACTION, type SyncPreviewFile, type SyncRunSummary } from '../syncParser.js'

/** The three actions δ's `open` mode shares with `p4 reconcile -a -e -d`. */
type ReconcileAction = Extract<P4Action, 'add' | 'edit' | 'delete'>

function isReconcileAction(action: string): action is ReconcileAction {
  return action === 'add' || action === 'edit' || action === 'delete'
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * The drift rows of an `open`-mode run, in the shape the Explorer hints and the
 * "Changes" group already consume — the same {@link ReconcileFile} the native
 * `reconcile -n` parser produces, so both engines feed one comparison path.
 *
 * Only `add` / `edit` / `delete` become rows. δ's open mode also reports the
 * `revert_*` groups (`p4 revert -a` semantics, not part of `reconcile -a -e -d`),
 * the `reopen_*` re-opens and `handoff` records for files it passed to native
 * p4; dropping them is what keeps this list equal to the native engine's, and
 * counting a revert as an edit would invent a change the depot does not have.
 */
export function toReconcileFiles(
  records: readonly P4deltaRecord[],
  clientRoot: string,
): ReconcileFile[] {
  const files: ReconcileFile[] = []
  let skipped = 0
  for (const record of records) {
    if (record['kind'] !== 'file' || record['mode'] !== 'open') continue
    const action = asString(record['action'])
    if (action === undefined || !isReconcileAction(action)) {
      skipped += 1
      continue
    }
    const depotFile = asString(record['depotFile'])
    // The contract guarantees depotFile on every file record; one without it is
    // malformed and has nothing a row could show.
    if (depotFile === undefined) continue
    const clientFile = asString(record['clientFile'])
    files.push({
      depotFile,
      // `clientFile` is client syntax by contract; when δ has no client root it
      // degrades to a local path instead, and clientToLocalPath passes any value
      // that does not start with `//` through untouched — exactly the fallback.
      clientFile: clientFile === undefined ? undefined : clientToLocalPath(clientFile, clientRoot),
      action,
      rev: asString(record['rev']),
    })
  }
  if (skipped > 0) {
    console.error(
      `[perforce] p4delta: dropped ${skipped} file record(s) that are not add/edit/delete`,
    )
  }
  return files
}

/** The conclusion of a run, as the summary record states it. */
export interface P4deltaSummary {
  /** Whether the run has a conclusion. Only an explicit `ok:true` counts. */
  readonly ok: boolean
  /**
   * The mode the run answered in — `open` / `clean` / `sync` by contract.
   * Undefined when the record did not state one; every reader compares it
   * against the mode it asked for, because a summary for another mode answers a
   * question nobody asked.
   */
  readonly mode: string | undefined
  /**
   * Whether the run APPLIED its answer or only previewed it (the contract ties
   * this to `-a`). A write must see `true`: a preview-shaped stream read as
   * success would mark paths handled while nothing on disk or server changed.
   */
  readonly applied: boolean
  /**
   * Whether the run was the FORCE repair that shares this mode. The two are
   * distinguishable only by this boolean — the records and the counts look the
   * same — and a force repair read as {@link toSyncOutcome}'s normal sync would
   * report overwritten local work as an ordinary get.
   */
  readonly force: boolean
  /** `class` → count. Only non-zero classes are emitted; an absent class is 0. */
  readonly counts: Record<string, number>
  readonly total: number
  /**
   * 普通同步的逐文件拒绝条数（`kind:"conflict"` 记录数）。契约保证每轮都发；
   * 缺席说明这份流没有结论，{@link toSyncOutcome} 返回 undefined——不回退、不猜。
   */
  readonly conflicts: number | undefined
  readonly unmatched: number
  /** `null` on success, `"no-entry-matched"` when every scope entry came up
   *  empty, `"error"` for any other failure. */
  readonly reason: string | null
}

/**
 * The run's conclusion, or undefined when it never reached one. Undefined is the
 * load-bearing answer: a stream without a summary is a run that was killed,
 * crashed or cancelled (contract hard rule 1), so the caller must fall back to
 * the native engine instead of reading the partial records as a complete — or
 * worse, empty — answer.
 */
export function summarizeRun(result: P4deltaRunResult): P4deltaSummary | undefined {
  // Last one wins: a run emits exactly one, and if a buggy build emits two the
  // later one is the newer ledger.
  for (let i = result.records.length - 1; i >= 0; i--) {
    const record = result.records[i]
    if (record === undefined || record['kind'] !== 'summary') continue
    return {
      // `ok` must be exactly true: the contract makes ok:false a partial stream,
      // and a missing ok must not be optimistically read as success.
      ok: record['ok'] === true,
      mode: asString(record['mode']),
      // Same rule as `ok`: only an explicit true proves the run applied.
      applied: record['applied'] === true,
      force: record['force'] === true,
      counts: readCounts(record['counts']),
      total: asNumber(record['total']),
      conflicts: asFiniteNumber(record['conflicts']),
      unmatched: asNumber(record['unmatched']),
      reason: asString(record['reason']) ?? null,
    }
  }
  return undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readCounts(raw: unknown): Record<string, number> {
  const counts: Record<string, number> = {}
  if (raw === null || typeof raw !== 'object') return counts
  for (const [klass, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[klass] = value
  }
  return counts
}

/**
 * How many native p4 processes a δ run reported starting (contract:
 * `kind:"p4CommandCount"` on stdout, and the final number on `summary.p4Calls`),
 * plus the per-command breakdown (`p4CallsByCommand` / the event's `command`).
 *
 * `observed` is the highest count the event stream carried — a LOWER BOUND when
 * no summary arrived (the run was killed, cancelled or crashed). `reported` is
 * the summary's own final number, or undefined when there is no summary or it
 * carried no valid one. Malformed values (negative, NaN, fractional, beyond the
 * safe-integer range, non-numbers) are ignored rather than trusted: this stream
 * is an engine's own output, and one bad event must not fabricate a count.
 *
 * 分类（`byCommand`）与总数是同一把账的两半：总数是「起了多少次 p4」，分类是「花在哪」。
 * 事件流逐次带上 `command`，所以**没有 summary 时分类仍是一份可用的下界**——取消 / 崩溃
 * 之后「这 37 次调用是什么」照样答得出来。两处取值都按 {@link P4DELTA_P4_COMMANDS} 收窄：
 * 契约说新类别可以随时加进来、消费方按未知值忽略，所以白名单之外的键一律丢掉，而不是让它
 * 变成一条谁都对不上账的账目。
 */
export interface P4deltaCallCount {
  readonly observed: number
  readonly reported: number | undefined
  /** Per-command tally from the event stream: a lower bound when no summary arrived. */
  readonly observedByCommand: Readonly<Record<string, number>>
  /** The summary's own final tally, or undefined when it stated none. */
  readonly reportedByCommand: Readonly<Record<string, number>> | undefined
  /**
   * summary 的分类账是否**自洽可信**（与总数 `complete` 相互独立）：条目一个没被丢（键全在契约
   * 枚举内、值都是非负安全整数）、各项之和恰好等于 `reported`、每类都不大于总数且不小于事件流
   * 已观测到的次数。任一不成立都为 false——此时分类只是**下界**，消费方绝不能冒称完整。
   */
  readonly reportedByCommandComplete: boolean
}

/** 契约里固定的 p4 命令类别（`docs/json-contract.md` 的 `kind:"p4CommandCount"` 表）。 */
const P4DELTA_P4_COMMANDS: ReadonlySet<string> = new Set([
  'set',
  'info',
  'client',
  'where',
  'have',
  'fstat',
  'opened',
  'ignores',
  'add',
  'edit',
  'delete',
  'revert',
  'sync',
  'reconcile',
  'clean',
])

function asCallCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** 受控读取分类账：只认契约枚举里的键与非负安全整数。`complete` 说的是「一个条目都没被丢」——
 *  未知键（未来新增类别、伪造键）与非法值（负 / 小数 / 非安全整数 / 非数字）都会把它置 false，
 *  因为它们让这份账对不上总数。合法的 `0` 不在此列：它是承诺范围内的非负计数，丢掉它既不改变
 *  各项之和，也不该把一份与总数自洽的账降级成下界（内部输出仍只保留非零项）。 */
function readCommandTally(
  raw: unknown,
): { tally: Record<string, number>; complete: boolean } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const tally: Record<string, number> = {}
  let complete = true
  for (const [command, value] of Object.entries(raw)) {
    const count = P4DELTA_P4_COMMANDS.has(command) ? asCallCount(value) : undefined
    if (count === undefined) {
      complete = false
      continue
    }
    if (count === 0) continue
    tally[command] = count
  }
  return { tally, complete }
}

export function readP4deltaCallCount(result: P4deltaRunResult): P4deltaCallCount {
  let observed = 0
  let reported: number | undefined
  let reportedByCommand: Record<string, number> | undefined
  let tallyComplete: boolean | undefined
  const observedByCommand: Record<string, number> = {}
  // 并发下 p4CommandCount 事件可能**乱序**抵达（count 大的先到），也可能重复。按 count 值去重，
  // 而不是拿 `count <= observed` 过滤——后者会把乱序到达的合法事件整条丢掉，让分类凭空少一笔。
  const seenCounts = new Set<number>()
  for (const record of result.records) {
    if (record['kind'] === 'p4CommandCount') {
      const count = asCallCount(record['count'])
      // 坏事件整条丢弃：计数不可信时它的 `command` 同样不可信，只留下类别会凭空多出一笔
      // 对不上总数的账。
      if (count === undefined) continue
      if (count > observed) observed = count
      // 0 事件（还没起任何进程）与重复 count 都不能给某个类别凭空加一笔。
      if (count < 1 || seenCounts.has(count)) continue
      seenCounts.add(count)
      const command = record['command']
      if (typeof command === 'string' && P4DELTA_P4_COMMANDS.has(command)) {
        // 事件是累计值：同一类别上的观测次数就是该类别收到的自增事件数。按 count 去重后每条
        // 事件恰好对应一次真实 spawn，所以这里就是计数。
        observedByCommand[command] = (observedByCommand[command] ?? 0) + 1
      }
    } else if (record['kind'] === 'summary') {
      // Last summary wins — same rule as {@link summarizeRun}.
      reported = asCallCount(record['p4Calls'])
      const read = readCommandTally(record['p4CallsByCommand'])
      reportedByCommand = read?.tally
      tallyComplete = read?.complete
    }
  }
  return {
    observed,
    reported,
    observedByCommand,
    reportedByCommand,
    reportedByCommandComplete: verifiesCommandTally(
      reported,
      reportedByCommand,
      tallyComplete,
      observedByCommand,
    ),
  }
}

/**
 * summary 的分类账要**自洽**才可信：每一类都不大于总数、每一项都不小于事件流已观测到的次数
 * （含 summary 一字未提、事件流却见过的类别——漏掉一整类与数值偏小同样是账不平）、各项之和
 * 恰好等于总数、且读取时一个条目都没被丢。任一不成立都说明这份账缺了条目或与总数对不上，
 * 消费方必须把它当**下界**，绝不能冒称完整。
 */
function verifiesCommandTally(
  reported: number | undefined,
  tally: Record<string, number> | undefined,
  tallyComplete: boolean | undefined,
  observedByCommand: Readonly<Record<string, number>>,
): boolean {
  if (tallyComplete !== true || reported === undefined || tally === undefined) return false
  let sum = 0
  // 两边的键都要遍历：只走 summary 的项，会漏掉「事件流见过、summary 一个字没提」的整类。
  for (const command of new Set([...Object.keys(tally), ...Object.keys(observedByCommand)])) {
    const count = tally[command] ?? 0
    if (count > reported || count < (observedByCommand[command] ?? 0)) return false
    sum += count
  }
  return sum === reported
}

/** A δ normal-sync run's answer, in the shapes the get pipeline already reads. */
export interface P4deltaSyncOutcome {
  /** The tally in {@link SyncRunSummary}'s own terms — the caller shows it to the
   *  user verbatim, so the mapping cannot be lossy in either direction. */
  readonly summary: SyncRunSummary
  /** Files the run rewrote, as {@link SyncPreviewFile} rows — the drift rows the
   *  caller may subtract afterwards. `class:"resolve"` records are NOT here: an
   *  opened file's content was not touched. */
  readonly appliedFiles: readonly SyncPreviewFile[]
  /** false：行数超过流式账的上限，{@link appliedFiles} 只是前一部分，漂移行要另行复核。 */
  readonly appliedFilesComplete: boolean
  readonly refusedFiles: readonly SyncPreviewFile[]
  readonly refusedOverwriteFiles: readonly SyncPreviewFile[]
  /** Nothing was behind: this run had no work to do. Refusals outrank it — a
   *  run that only refused files is not "up to date" (same rule as the native
   *  parser's). */
  readonly upToDate: boolean
}

/** 内容真正落盘的同步类；`resolve` 是它的第四个（已签出文件，have 前进但内容未动）。 */
const APPLIED_SYNC_CLASSES = new Set(['add', 'update', 'delete'])

/** 强制修复档的类表：与普通 get 共有 `update`/`delete`，另有 `revert`（漂移内容写回目标）、
 *  `restore`（本地缺失的文件补回）与 `untracked`（`--delete-untracked` 删掉的本地文件）；
 *  没有 `add`（p4 把写回报成 `restore`）。 */
const APPLIED_FORCE_CLASSES = new Set(['update', 'revert', 'restore', 'delete', 'untracked'])

/** What one sync run's file records say, before any conclusion is drawn. */
interface SyncRecordTally {
  /** Files whose content the run rewrote, in stream order — at most the tally's row cap. */
  readonly applied: SyncPreviewFile[]
  /** Every applied record, the rows dropped past the cap included. */
  readonly appliedCount: number
  /** `class:"resolve"` records: opened files whose have moved to the target. */
  readonly resolve: number
  /** `class:"delete"` records: tracked files removed because the target revision has no
   *  such path. Rows in {@link applied}; the summary also reports them as an applied
   *  SUBSET so history can split updates from sync deletions. */
  readonly trackedDeleted: number
  /** `class:"untracked"` records: local files deleted by `--delete-untracked`. They
   *  are rows in {@link applied} (their drift rows are gone), but the summary
   *  reports them under their own count so history can tell the two apart. */
  readonly untracked: number
  /** `class:"handoff"`：整批转交给原生 p4 的文件，只有强制修复档会发（见
   *  {@link SyncRunSummary.handoff}）。 */
  readonly handoff: number
  /** 不属于本档类表的记录（另一档的词汇、绑给别的 mode 的 `handoff`，或未来版本的新类）：
   *  流在回答另一个问题。 */
  readonly foreign: boolean
}

/**
 * 边收边记的 sync 记录账。宽范围 get 的 file 记录可达数百万条：服务不再囤它们
 * （`retainFileRecords: false`），由调用方在 `onRecord` 里逐条喂进来。
 *
 * 行列表有上限 `rowCap`，超过只计数不留行；调用方据 {@link rowsComplete} 改走漂移行复核，
 * 不能拿残缺的行列表当作「只改了这些」。
 */
export class P4deltaSyncTally implements SyncRecordTally {
  readonly applied: SyncPreviewFile[] = []
  appliedCount = 0
  resolve = 0
  trackedDeleted = 0
  untracked = 0
  handoff = 0
  foreign = false
  /**
   * `stage:"apply"` 的已落盘行，同受上限约束。给**被取消**的 get 用：没有 summary 就没有结论，
   * 只有已经到达的记录能说明落了什么——p4 报为 applied 的文件已在盘上、与 have 一致，它们的
   * 漂移行与正常退出时一样作废。
   *
   * 只认 `stage:"apply"`，刻意核对而不是假定：契约说 `-a` 只发 apply 段记录，但这是唯一一个
   * 读错会**藏起本地改动**的读取器——把预演记录当成已落盘，会作废一个没被写过的文件的漂移行。
   */
  readonly applyStage: SyncPreviewFile[] = []
  applyStageCount = 0
  /** 流里出现过 `stage:"apply"` 的 file 记录：引擎已经开始写盘。 */
  sawApplyRecord = false

  constructor(
    private readonly _clientRoot: string,
    private readonly _force: boolean,
    private readonly _rowCap = Number.POSITIVE_INFINITY,
  ) {}

  get rowsComplete(): boolean {
    return this.applied.length === this.appliedCount
  }

  get applyStageComplete(): boolean {
    return this.applyStage.length === this.applyStageCount
  }

  push(record: P4deltaRecord): void {
    // 认出异类流后整份账作废，后面的记录不再读。
    if (this.foreign) return
    if (record['kind'] !== 'file' || record['mode'] !== 'sync') return
    const isApply = record['stage'] === 'apply'
    if (isApply) this.sawApplyRecord = true
    const klass = asString(record['class'])
    if (klass === undefined) {
      this.foreign = true
      return
    }
    if (klass === 'handoff') {
      // handoff 字段写明这批文件交给了哪条原生命令，修复档是 `sync`；
      // clean/reconcile 的属于别档的流，普通 get 根本不发。
      if (!this._force || record['handoff'] !== 'sync') this.foreign = true
      else this.handoff += 1
      return
    }
    if (!this._force && klass === 'resolve') {
      this.resolve += 1
      return
    }
    if (this._force && klass === 'untracked') {
      // 只删磁盘、不进 have：行仍进 applied（它的漂移行随文件一起消失），但单独计数，
      // 汇总里从 applied 扣掉，历史才能把「同步了几个文件」与「删了几个未跟踪文件」分开。
      const row = syncFileRow(record, this._clientRoot)
      // 计数要跟着行一起成立：只计一条记不出身份的记录，会让 `applied - untrackedDeleted`
      // 变成负数并写进历史。缺身份字段的流回答不了这个问题，按异类流处理。
      if (row === undefined) {
        this.foreign = true
        return
      }
      this._addApplied(row, isApply)
      this.untracked += 1
      return
    }
    const allowed = this._force ? APPLIED_FORCE_CLASSES : APPLIED_SYNC_CLASSES
    if (!allowed.has(klass)) {
      this.foreign = true
      return
    }
    const row = syncFileRow(record, this._clientRoot)
    if (row !== undefined) {
      this._addApplied(row, isApply)
      // 已跟踪删除是 applied 的子集；只有真正建出行、能对上身份的才计数。
      if (klass === 'delete') this.trackedDeleted += 1
    }
  }

  private _addApplied(row: SyncPreviewFile, isApply: boolean): void {
    this.appliedCount += 1
    if (this.applied.length < this._rowCap) this.applied.push(row)
    if (!isApply) return
    this.applyStageCount += 1
    if (this.applyStage.length < this._rowCap) this.applyStage.push(row)
  }
}

function tallySyncRecords(
  records: readonly P4deltaRecord[],
  clientRoot: string,
  force: boolean,
): P4deltaSyncTally {
  const tally = new P4deltaSyncTally(clientRoot, force)
  for (const record of records) tally.push(record)
  return tally
}

/** 结构化冲突的已知 reason → 给 UI 读的 action 文案。`delete-modified` 与原生解析器
 *  共用同一个常量：那个文件不能做逐文件 force（钉 have 版本会把已删的文件复活）。 */
const CONFLICT_ACTIONS: Readonly<Record<string, string>> = {
  'update-modified': 'not updated',
  'delete-modified': REFUSED_DELETE_ACTION,
  'overwrite-existing': 'not updated',
}

/** 一次 sync 记录流里的冲突，分成原生解析器已有的两个桶。 */
interface SyncConflictTally {
  readonly refused: SyncPreviewFile[]
  readonly overwrite: SyncPreviewFile[]
  /** 流里 `kind:"conflict"` 记录的**原始条数**；summary.conflicts 与它对账。 */
  readonly count: number
  /** 认不出 reason 或缺身份字段：这份流不是我们理解的那版契约。 */
  readonly foreign: boolean
}

/**
 * Read `kind:"conflict"` records (normal sync's per-file refusals) into the same
 * {@link SyncPreviewFile} rows the native output parser produces, so remedies
 * stay identical across engines.
 *
 * The reason decides the bucket: `overwrite-existing` means there is no local
 * modification to collect or diff (the file is not in the have table), so it
 * keeps its own list; the other two are "locally modified" refusals. An unknown
 * reason is treated as a foreign stream rather than dropped — a newer engine
 * may have introduced a refusal shape whose remedy we do not know yet.
 */
function collectSyncConflicts(
  records: readonly P4deltaRecord[],
  clientRoot: string,
): SyncConflictTally {
  const refused: SyncPreviewFile[] = []
  const overwrite: SyncPreviewFile[] = []
  const seen = new Set<string>()
  let count = 0
  for (const record of records) {
    if (record['kind'] !== 'conflict' || record['mode'] !== 'sync') continue
    count += 1
    const reason = asString(record['reason'])
    if (reason === undefined || CONFLICT_ACTIONS[reason] === undefined) {
      return { refused, overwrite, count, foreign: true }
    }
    const depotFile = asString(record['depotFile'])
    if (depotFile === undefined) return { refused, overwrite, count, foreign: true }
    const clientFile = asString(record['clientFile'])
    const row: SyncPreviewFile = {
      depotFile,
      // Client syntax by contract; `clientToLocalPath` passes degraded local
      // paths through untouched, exactly like {@link syncFileRow}.
      clientFile: clientFile === undefined ? undefined : clientToLocalPath(clientFile, clientRoot),
      action: CONFLICT_ACTIONS[reason]!,
      rev: asString(record['rev']) ?? '',
    }
    // 引擎已经去过重；这里再按身份去一次，因为这两个列表会被直接拿去拼补救按钮。
    const key = `${row.depotFile}\u0000${row.clientFile ?? ''}\u0000${row.rev}\u0000${row.action}`
    if (seen.has(key)) continue
    seen.add(key)
    if (reason === 'overwrite-existing') overwrite.push(row)
    else refused.push(row)
  }
  return { refused, overwrite, count, foreign: false }
}

/**
 * Read a δ sync run, or undefined when the stream has no conclusion. Undefined
 * is load-bearing and means the same thing it does for {@link summarizeRun}: the
 * caller must not read partial records as an answer.
 *
 * `applied` is the run the caller ASKED for: true for a real get (`-a`), false
 * for a preview. A summary that does not match it (a build that ignored `-a`, or
 * an answer for the other direction) is not an answer to this question — a
 * preview-shaped stream read as a write would drop drift rows while nothing on
 * disk changed.
 *
 * `expectForce` 是请求的另一半：两档共用 `mode:"sync"` 与部分类表，这个布尔是唯一区分——读错任
 * 一方向都会把「覆盖」与「普通拉取」互认，所以每档只认自己的类表。
 *
 * Refusals are read only from the structural records (`kind:"conflict"`); the
 * engine's stderr text is never parsed. Every sync summary carries a `conflicts`
 * count by contract (normal or force, preview or apply), so a stream without it —
 * or one whose count disagrees with the records — is incomplete and has no
 * conclusion. A force run emits no conflicts; records in one are a stream from
 * another mode.
 *
 * `streamed`：以 `retainFileRecords: false` 跑的 get，file 记录不在 `result.records` 里，
 * 由调用方在 `onRecord` 里记好的账代替。
 */
export function toSyncOutcome(
  result: P4deltaRunResult,
  clientRoot: string,
  applied: boolean,
  expectForce = false,
  streamed?: P4deltaSyncTally,
): P4deltaSyncOutcome | undefined {
  const summary = summarizeRun(result)
  if (summary === undefined || !summary.ok) return undefined
  if (summary.mode !== 'sync' || summary.applied !== applied || summary.force !== expectForce) {
    return undefined
  }
  const tally = streamed ?? tallySyncRecords(result.records, clientRoot, expectForce)
  if (tally.foreign) return undefined
  const conflicts = collectSyncConflicts(result.records, clientRoot)
  // 强制修复不走原生那套逐文件保护，冲突记录只属于普通同步；出现了说明流串档。
  if (conflicts.foreign || (expectForce && conflicts.count > 0)) return undefined
  // 契约保证 summary 恒发 conflicts：缺席即「这份流没有结论」，不回退 stderr、不猜。
  if (summary.conflicts !== conflicts.count) return undefined

  const refusedFiles = conflicts.refused
  const refusedOverwriteFiles = conflicts.overwrite
  // An opened file whose have moved makes p4 print BOTH "is opened and not being
  // changed" (a skip) and "must resolve #N before submitting" (work left). The
  // engine collapses that pair into one `resolve` record, so it feeds both
  // counters — otherwise a get that needs a resolve stops offering the button
  // for it.
  const keptOpen = tally.resolve
  const mustResolve = tally.resolve
  const refusedModified = refusedFiles.length
  const refusedOverwrite = refusedOverwriteFiles.length
  const handoff = tally.handoff
  const untrackedDeleted = tally.untracked
  // `total` is the run's own ledger — in an applied run it counts exactly the
  // records above — so a zero total is the engine saying "no files to sync".
  // Refusals outrank it, same rule as the native parser's.
  // 转交出去的那批同样优先：账本刻意不记它，但它是真实发生的工作。
  // 未跟踪删除也在 `tally.applied` 里（它的漂移行同样作废），所以这一条已覆盖它。
  const upToDate =
    summary.total === 0 &&
    tally.appliedCount === 0 &&
    keptOpen === 0 &&
    refusedModified === 0 &&
    refusedOverwrite === 0 &&
    handoff === 0
  return {
    summary: {
      // 未跟踪删除单独计数：它删的是 depot 从不跟踪的文件，与「同步了几个文件」不是
      // 同一件事，历史里要分开显示。tally.applied 仍保留它，供漂移行作废使用。
      applied: tally.appliedCount - untrackedDeleted,
      // 已跟踪删除仍是 applied 的一部分（不扣除），只作为子集上报。
      trackedDeleted: tally.trackedDeleted,
      keptOpen,
      mustResolve,
      refusedModified,
      refusedOverwrite,
      handoff,
      ...(untrackedDeleted > 0 ? { untrackedDeleted } : {}),
      upToDate,
      // The ledger claimed work and nothing at all accounts for it — the caller
      // must log that rather than show "0 applied" as a finished get. A refusal
      // IS an account (the file was named, on the other channel), so it keeps
      // this off exactly as it keeps `upToDate` off.
      unrecognized:
        !upToDate &&
        tally.appliedCount === 0 &&
        tally.resolve === 0 &&
        refusedModified === 0 &&
        refusedOverwrite === 0 &&
        handoff === 0,
    },
    appliedFiles: tally.applied,
    appliedFilesComplete: tally.rowsComplete,
    refusedFiles,
    refusedOverwriteFiles,
    upToDate,
  }
}

/**
 * One `file` record as a {@link SyncPreviewFile}. `nativeAction` (the verb p4
 * itself printed) is preferred over `action` (the class-derived one) so the
 * preview reads exactly like the native engine's rows; a `resolve` record has
 * neither — it is never a row, see {@link toSyncOutcome}.
 */
function syncFileRow(record: P4deltaRecord, clientRoot: string): SyncPreviewFile | undefined {
  const depotFile = asString(record['depotFile'])
  if (depotFile === undefined) return undefined
  const clientFile = asString(record['clientFile'])
  return {
    depotFile,
    // Client syntax by contract; `clientToLocalPath` passes non-`//` values
    // through, which is exactly the degraded spelling the contract allows.
    clientFile: clientFile === undefined ? undefined : clientToLocalPath(clientFile, clientRoot),
    action: asString(record['nativeAction']) ?? asString(record['action']) ?? '',
    rev: asString(record['rev']) ?? '',
  }
}
