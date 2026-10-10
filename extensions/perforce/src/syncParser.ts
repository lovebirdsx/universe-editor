/**
 * Parsers for `p4 sync` / `p4 resolve` output. Pure — the p4Service runs the
 * commands, these shape the text, and the client turns the summaries into user
 * feedback. `p4 sync -n` (dry-run preview) reports structured records; a real
 * `p4 sync` prints one plain-text line per file, and `p4 resolve -am` prints
 * merge transcripts that mix landed and skipped files even when it exits 0 —
 * hence the two counters in {@link ResolveRunSummary}.
 *
 * Three refusal shapes exist and none may be dropped on the floor: an
 * `allwrite noclobber` client refuses a locally-modified file per file
 * (`- can't update modified file`, stdout, exit 0, run continues — counted by
 * {@link SyncRunSummary.refusedModified} and extracted by
 * {@link parseSyncRefused}), refuses an untracked file already on disk per file
 * (`- can't overwrite existing file`, stdout, exit 0, run continues — counted by
 * {@link SyncRunSummary.refusedOverwrite}), while a `noallwrite` client aborts
 * the whole run (`can't clobber writable file`, stderr, exit 1 — classified in
 * `p4Error.ts`). 同族还有第二个词 `- can't delete modified file`（目标修订把文件删了、本地却仍
 * 有未收集改动），计入同一个计数器，差别只在行上 `#rev` 的含义——见 {@link isForceGettableRefusal}。
 *
 * Verified against P4D 2024.2 (see `e2e/fixtures/PROBE-FINDINGS.md`).
 */

import { clientToLocalPath } from './pathUtil.js'

/**
 * One file `p4 sync -n` (dry-run) would touch.
 *
 * Unlike `p4 opened` / `p4 reconcile -n`, sync's `clientFile` is already a
 * **local** path (`E:\ws\a.cpp`) — measured, not assumed. `clientRoot` is still
 * threaded through {@link clientToLocalPath}, which passes non-`//` values back
 * verbatim, so the field is correct either way and a future server that switches
 * to client syntax doesn't reintroduce the phantom-delete class of bug.
 */
export interface SyncPreviewFile {
  /** Depot path, e.g. `//depot/branch_x/a.cpp`. */
  readonly depotFile: string
  /** Local filesystem path, when known (from `clientFile`). */
  readonly clientFile: string | undefined
  /** What the sync would do: updated / added / deleted / refreshing. */
  readonly action: string
  /** Target revision, when reported. */
  readonly rev: string
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Parse one `sync -n` JSON record, or undefined when it carries no depot path. */
export function parseSyncPreviewRecord(
  record: Record<string, unknown>,
  clientRoot?: string,
): SyncPreviewFile | undefined {
  const depotFile = asString(record['depotFile'])
  if (!depotFile) return undefined
  const rawClientFile = asString(record['clientFile'])
  const clientFile =
    rawClientFile && clientRoot ? clientToLocalPath(rawClientFile, clientRoot) : rawClientFile
  return {
    depotFile,
    clientFile,
    action: asString(record['action']) ?? '',
    rev: asString(record['rev']) ?? '',
  }
}

export function parseSyncPreview(
  records: readonly Record<string, unknown>[],
  clientRoot?: string,
): SyncPreviewFile[] {
  const out: SyncPreviewFile[] = []
  for (const r of records) {
    const file = parseSyncPreviewRecord(r, clientRoot)
    if (file) out.push(file)
  }
  return out
}

/**
 * The untruncated total of files a `sync -n` would act on, from the
 * `totalFileCount` key — or undefined on servers that don't emit it.
 *
 * Measured on P4D 2024.2: the key appears in the FIRST file record only, as
 * ONE grand total across every filespec (two-scope probe under `-m 501`:
 * 463 truncated records, a single `totalFileCount 1941` line). It counts
 * every file the sync would touch or refuse — the structured records PLUS
 * the plain `- can't update modified file` / `- added as` lines (measured
 * 297 = 259 records + 38 plain lines) — and `-m` truncates the records,
 * never this total. Last value wins defensively; the measured shape has
 * exactly one.
 */
export function parseSyncPreviewTotal(
  records: readonly Record<string, unknown>[],
): number | undefined {
  let total: number | undefined
  for (const r of records) {
    const v = asString(r['totalFileCount'])
    if (v === undefined) continue
    const n = Number(v)
    if (Number.isInteger(n) && n >= 0) total = n
  }
  return total
}

/**
 * Tally of a real `p4 sync` run, split so the caller can show what actually
 * happened instead of a bare "done".
 */
export interface SyncRunSummary {
  /** Files successfully updated on disk (updated/added/deleted/refreshing). */
  readonly applied: number
  /** Files p4 skipped because they are open (`is opened and can't be replaced`). */
  readonly keptOpen: number
  /** Files p4 reported as needing a resolve first (`must resolve`). */
  readonly mustResolve: number
  /**
   * 本地改了但未打开、被原生逐个跳过的文件——`allwrite noclobber` 客户端的逐文件拒绝，
   * 含两个词：`- can't update modified file`（文件落后）与 `- can't delete modified file`
   * （目标修订删掉了它）。两者都是 **stdout、exit 0**、run 继续，都是「有未收集的本地改动」，
   * 故共用一个计数器与 collect/diff 补救。clobber 拒绝（`noallwrite`）是另一形态：stderr、
   * exit 1、整轮中断——见 {@link classifySyncError}。漏解析的拒绝会被读成「无事可做」，让调用
   * 方把落后的文件报成已是最新。
   */
  readonly refusedModified: number
  /**
   * Files p4 skipped because an UNTRACKED file already sits at the target path —
   * the `allwrite noclobber` client's per-file refusal `- can't overwrite
   * existing file` (measured on P4D 2024.2 under `--parallel`: stdout, exit 0,
   * run continues). Distinct from {@link refusedModified}: `p4 have` has no
   * record of these files, so there is no local "modification" to diff or
   * collect — the remedy is a force get (or the user removing the orphan), never
   * "Collect Changes".
   */
  readonly refusedOverwrite: number
  /**
   * δ 强制修复整批转交给原生 `p4` 的文件（`class:"handoff"`）：只能证明那条原生命令执行成功，
   * 逐文件结果未知，所以单独计数、不折进 {@link applied}，也不参与漂移计算；原生路径恒为 0。
   */
  readonly handoff: number
  /**
   * True when p4 reported `file(s) up-to-date.`. Measured on P4D 2024.2: this
   * arrives on **stderr with exit 0** — nothing to do, not a failure.
   */
  readonly upToDate: boolean
  /** stdout had content but no line was recognized — the caller must log it. */
  readonly unrecognized: boolean
}

// `refreshed`/`updating` are older-server spellings of the same disk-applied
// outcome as `refreshing`/`updated`. NOTE: a clobber refusal prints the same
// `- updating <local>` line before failing (PROBE-FINDINGS §11.8), so that line
// is counted as applied even though nothing landed — accepted because the error
// path (`classifySyncError`) never reads this summary; the count is log-only
// inflation there.
const APPLIED_LINE = / - (updated|added|deleted|refreshing|refreshed|updating)( as)? /i
const KEPT_OPEN_LINE = /is opened and (can't be replaced|not being changed)/i
const MUST_RESOLVE_LINE = / must resolve /i
const UP_TO_DATE_LINE = /file\(s\) up-to-date/i
// `allwrite noclobber` 客户端的逐文件拒绝，两个词：`update`（文件落后）与 `delete`（目标修订
// 删掉了它）。不会与 APPLIED_LINE 相撞：后者要求 ` - ` 后紧跟 updated/updating/…，这里紧跟
// 的是 `can't`。
const REFUSED_MODIFIED_LINE = / - can't (?:update|delete) modified file /i
// The untracked-orphan refusal. Same `allwrite noclobber` client and channel as
// REFUSED_MODIFIED_LINE, but the file is NOT in the have table — so there is no
// local modification to collect or diff, and it gets its own counter so the
// caller can offer force-get instead of the modified-file remedies.
const REFUSED_OVERWRITE_LINE = / - can't overwrite existing file /i
// 单独的 delete 词，事后用来区分两类。
const REFUSED_DELETE_LINE = / - can't delete modified file /i

/**
 * What one line of `p4 sync` stdout means. `file(s) up-to-date.` has no kind
 * here — that is a whole-run verdict spanning stdout + stderr, not a line
 * outcome.
 */
export type SyncLineKind = 'applied' | 'keptOpen' | 'mustResolve' | 'refused' | 'refusedOverwrite'

/**
 * Classify one line of `p4 sync` stdout, or undefined when nothing matches.
 *
 * Applies the five counting patterns in the same order
 * {@link parseSyncOutput} uses (applied → keptOpen → mustResolve → refused →
 * refusedOverwrite), so a streaming progress counter and the final summary share
 * one source of truth instead of each writing its own copy of the rules. The
 * line is trimmed here — callers may pass raw, unterminated chunks.
 */
export function classifySyncLine(line: string): SyncLineKind | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  if (APPLIED_LINE.test(trimmed)) return 'applied'
  if (KEPT_OPEN_LINE.test(trimmed)) return 'keptOpen'
  if (MUST_RESOLVE_LINE.test(trimmed)) return 'mustResolve'
  if (REFUSED_MODIFIED_LINE.test(trimmed)) return 'refused'
  if (REFUSED_OVERWRITE_LINE.test(trimmed)) return 'refusedOverwrite'
  return undefined
}

export function parseSyncOutput(stdout: string, stderr: string): SyncRunSummary {
  let applied = 0
  let keptOpen = 0
  let mustResolve = 0
  let refusedModified = 0
  let refusedOverwrite = 0
  for (const raw of stdout.split(/\r?\n/)) {
    const kind = classifySyncLine(raw)
    if (kind === 'applied') applied++
    else if (kind === 'keptOpen') keptOpen++
    else if (kind === 'mustResolve') mustResolve++
    else if (kind === 'refused') refusedModified++
    else if (kind === 'refusedOverwrite') refusedOverwrite++
  }
  const upToDate = UP_TO_DATE_LINE.test(`${stdout}\n${stderr}`)
  const unrecognized =
    stdout.trim() !== '' &&
    applied === 0 &&
    keptOpen === 0 &&
    mustResolve === 0 &&
    refusedModified === 0 &&
    refusedOverwrite === 0 &&
    !upToDate
  return {
    applied,
    keptOpen,
    mustResolve,
    refusedModified,
    refusedOverwrite,
    // 原生 p4 没有转交这种形态，该字段是给 δ 读取器的共享形状。
    handoff: 0,
    upToDate,
    unrecognized,
  }
}

/**
 * Whether a run left nothing to report: no summary at all, or every one of the
 * six counts at zero.
 *
 * Shared by `runSync`'s result branches and the sync history, because the two
 * must agree on what "nothing happened" means — the toast decides between
 * "already at the latest revision" and "returned no recognized result" with
 * it, and the history stores the same verdict as `upToDate` / `unrecognized`.
 * Two copies of the six-way count would drift the moment a seventh counter is
 * added (handoff was the last one to join).
 */
export function syncNothingHappened(summary: SyncRunSummary | undefined): boolean {
  return (
    summary === undefined ||
    (summary.applied === 0 &&
      summary.keptOpen === 0 &&
      summary.mustResolve === 0 &&
      summary.refusedModified === 0 &&
      summary.refusedOverwrite === 0 &&
      summary.handoff === 0)
  )
}

// The depot path leads every sync line (`//depot/branch_x/a.cpp[#3]`, with a
// `... ` prefix on must-resolve previews), while the local path appears only
// on some shapes and may contain spaces — so the last depot segment is the
// only stable file anchor.
const SYNC_DEPOT_LEAD = /^(?:\.\.\.\s+)?\/\/(\S+)/

/**
 * The file a sync line refers to, as a display name — the last depot path
 * segment without its `#rev` suffix (e.g. `a.cpp`), or undefined when the
 * line carries no recognizable depot path.
 */
export function syncLineFile(line: string): string | undefined {
  const depot = SYNC_DEPOT_LEAD.exec(line.trim())?.[1]
  if (!depot) return undefined
  const hashIdx = depot.indexOf('#')
  const path = hashIdx === -1 ? depot : depot.slice(0, hashIdx)
  const slashIdx = path.lastIndexOf('/')
  const name = slashIdx === -1 ? path : path.slice(slashIdx + 1)
  return name || undefined
}

/**
 * The refused-modified lines as structured files.
 *
 * Both output modes lose these: `-ztag` drops them (no `... key value` prefix)
 * and `-Mj` collapses them into a `{"data":…}` blob. Yet each one means "this
 * file is behind AND has uncollected local work" — folding them back in is what
 * keeps `previewSync`'s up-to-date verdict and the revision chip's `↓` from
 * contradicting one another on a narrow scope. It is also where
 * the "View Diff" remedy on a refused get gets its paths.
 *
 * `action` is the literal shown in the preview quick-pick and the Explorer
 * badge tooltip, so it reads as prose there, not as a p4 verb.
 */
const REFUSED_EXTRACT = /^(.*?)#(\d+) - can't (?:update|delete) modified file (.*)$/i

/**
 * `#rev` 不是目标修订的那类拒绝的 action。
 *
 * update 拒绝带的是要拉进来的目标修订（force 补救会钉住它）；delete 拒绝没有目标修订
 * （depot 已删），那行 `#rev` 是 have 修订——客户端手上已有的版本。
 */
export const REFUSED_DELETE_ACTION = 'not deleted'

/**
 * 这个被拒文件能否成为逐文件 `-f` 目标
 * （{@link import('./p4Filespec.js').buildForceGetFilespecs}）。
 *
 * delete 拒绝一律否：钉 `depot#<have>` 会把旧修订拉回来，复活一个 depot 已删的文件；不带修订的
 * depot 路径又是另一种用户没要过的 get。安全答案是不给它逐文件 force——collect/diff 仍适用，
 * 少一行的代价很小。
 */
export function isForceGettableRefusal(file: SyncPreviewFile): boolean {
  return file.action !== REFUSED_DELETE_ACTION
}

export function parseSyncRefused(stdout: string, clientRoot?: string): SyncPreviewFile[] {
  const out: SyncPreviewFile[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    const match = REFUSED_EXTRACT.exec(line)
    if (!match) continue
    const depotFile = match[1]
    const rev = match[2]
    if (!depotFile || !rev) continue
    const rawClientFile = match[3] ?? ''
    const clientFile =
      rawClientFile && clientRoot ? clientToLocalPath(rawClientFile, clientRoot) : rawClientFile
    out.push({
      depotFile,
      clientFile,
      action: REFUSED_DELETE_LINE.test(line) ? REFUSED_DELETE_ACTION : 'not updated',
      rev,
    })
  }
  return out
}

/**
 * The refused-overwrite lines as structured files — same shape and channel as
 * {@link parseSyncRefused}, but for the untracked-orphan refusal. Kept separate
 * from it: these files are NOT in the have table, so they must never flow into
 * the collect/diff remedies; the caller lists them in the force-get picker with
 * their own label color.
 */
const REFUSED_OVERWRITE_EXTRACT = /^(.*?)#(\d+) - can't overwrite existing file (.*)$/i

export function parseSyncOverwriteRefused(stdout: string, clientRoot?: string): SyncPreviewFile[] {
  const out: SyncPreviewFile[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const match = REFUSED_OVERWRITE_EXTRACT.exec(raw.trim())
    if (!match) continue
    const depotFile = match[1]
    const rev = match[2]
    if (!depotFile || !rev) continue
    const rawClientFile = match[3] ?? ''
    const clientFile =
      rawClientFile && clientRoot ? clientToLocalPath(rawClientFile, clientRoot) : rawClientFile
    out.push({ depotFile, clientFile, action: 'not updated', rev })
  }
  return out
}

/**
 * The applied lines as structured files — the server's own per-file record of
 * what a sync actually rewrote (`<depot>#<rev> - <verb>[ as] <local>`). The
 * client subtracts these from the working-tree drift set: a file p4 just
 * overwrote matches its (new) have revision, so any drift row for it is stale.
 * Refused rows are NOT in this list by construction (their verbs differ), but
 * the caller still differences against the refused lists because a clobber
 * refusal prints `- updating <local>` before failing (see {@link APPLIED_LINE}).
 *
 * `( as)?` and the verb table mirror {@link APPLIED_LINE} — `updated as
 * <local>` carries `as`, `refreshing <local>` / `deleted <local>` do not. `#rev`
 * is optional so extraction never narrows the set the counter accepted.
 */
const APPLIED_EXTRACT =
  /^(.+?)(?:#(\d+))? - (updated|added|deleted|refreshing|refreshed|updating)(?: as)? (.+)$/i

export function parseSyncAppliedLine(
  line: string,
  clientRoot?: string,
): SyncPreviewFile | undefined {
  const trimmed = line.trim()
  // Classify first, extract second: counting and extraction share one rule, so
  // a line the summary counted is never one this function declined (and the
  // caller's `appliedFiles.length < summary.applied` gap check stays honest).
  if (classifySyncLine(trimmed) !== 'applied') return undefined
  const match = APPLIED_EXTRACT.exec(trimmed)
  if (!match) return undefined
  const depotFile = match[1]
  if (!depotFile) return undefined
  const rawClientFile = match[4] ?? ''
  return {
    depotFile,
    rev: match[2] ?? '',
    action: (match[3] ?? '').toLowerCase(),
    clientFile:
      rawClientFile && clientRoot ? clientToLocalPath(rawClientFile, clientRoot) : rawClientFile,
  }
}

export function parseSyncApplied(stdout: string, clientRoot?: string): SyncPreviewFile[] {
  const out: SyncPreviewFile[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const file = parseSyncAppliedLine(raw, clientRoot)
    if (file) out.push(file)
  }
  return out
}

/**
 * Tally of a `p4 resolve -am` run. `-am` exits 0 even when some files are left
 * unresolved — a silent-failure trap — so landed and skipped files are counted
 * separately for the caller to surface.
 */
export interface ResolveRunSummary {
  /** Files that landed automatically (`- copy from` / `- merged` / `- merge
   *  from` / `- ignored`). */
  readonly merged: number
  /** Files still left to resolve (`resolve skipped`). */
  readonly remaining: number
  /** stdout had content but no line was recognized — the caller must log it. */
  readonly unrecognized: boolean
}

// Measured on P4D 2024.2 (PROBE-FINDINGS §11.4): `-am` reports a landed file
// with `- copy from` (accept-theirs/`-at`) or `- merge from` (real auto-merge),
// and `- ignored` when the incoming change is already in the local content —
// all three mean "this file is resolved".
const LANDED_LINE = / - (copy from|merged|merge from|ignored) /i
const SKIPPED_LINE = /resolve skipped/i
// Lines every real transcript carries but that are not an outcome: the per-file
// `<local> - merging <depot>` header and the merge-statistics line. Recognizing
// them keeps `unrecognized` honest — it must fire only for output nothing can
// account for, and a successful -am transcript contains both.
const NOISE_LINE = / - merging\b|^Diff chunks: /i

export function parseResolveOutput(stdout: string): ResolveRunSummary {
  let merged = 0
  let remaining = 0
  let recognized = false
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (LANDED_LINE.test(line)) {
      merged++
      recognized = true
    } else if (SKIPPED_LINE.test(line)) {
      remaining++
      recognized = true
    } else if (NOISE_LINE.test(line)) {
      recognized = true
    }
  }
  const unrecognized = stdout.trim() !== '' && !recognized
  return { merged, remaining, unrecognized }
}
