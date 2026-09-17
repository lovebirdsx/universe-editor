/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  按签名清扫 e2e 遗留进程。每个 fixture 的 userDataDir 是本次运行唯一的绝对路径，
 *  被测 app 整棵树（`--user-data-dir=<dir>`）与它拉起的 remote-server daemon
 *  （`--data-dir <dir>/remote-direct/<authority>`）命令行里都含它，于是「命令行含该路径」
 *  就是一组精确的进程归属签名：不依赖 ppid 图（主进程已死也能找到），也不会误伤无关进程。
 *
 *  纯函数与 IO 分层：选择逻辑（parseProcessTable / ancestorPids / collectDescendants /
 *  containsMarker / planProcessSweep）无副作用可单测，扫描与 kill 在 readProcessTable /
 *  sweepProcesses。IO 层在 win32 上是空实现——Windows 的整树回收由 launch.ts 的 CIM 走查
 *  与 taskkill /T 负责，那是已验证路径，不在此处叠加第二套。
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'

export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly args: string
}

export interface ProcessSweepPlan {
  /** 命中的 pid（保持进程表顺序）。 */
  readonly pids: readonly number[]
  /** 命中的行，供日志与事后分析。 */
  readonly rows: readonly ProcessRow[]
}

export interface PlanProcessSweepOptions {
  /** 永不参与命中的 pid 本身（不清扫其子树）。 */
  readonly excludePids?: readonly number[]
  /** 其整棵子树都永不参与命中的根 pid。 */
  readonly excludeSubtrees?: readonly number[]
}

export interface SweepProcessesOptions extends PlanProcessSweepOptions {
  /** 只算不杀，用于验证归属判定。 */
  readonly dryRun?: boolean
}

// 把 marker 当整段 argv token / 路径段匹配，而不是裸子串。
// 左边界：另一个目录可能是它的后缀（marker `/tmp/x` 不该命中 `/home/u/tmp/x`）。
// 右边界：mkdtemp 的兄弟目录可能把它当前缀（marker `<dir>` 不该命中 `<dir>-extra`），
// 运行的 run 根与 fixture 目录正是这种前缀关系，而 run 根之间也会互相成为前缀。
// 放宽 → 误杀同批其他 worker 的 app 或开发者的常驻 daemon；收紧 → daemon 漏网。
const MARKER_LEFT = /[\s=:'"[\]()]/
const MARKER_RIGHT = /[\s/"'\\,\]]/

export function containsMarker(args: string, marker: string): boolean {
  if (marker === '') return false
  for (let from = 0; ; ) {
    const at = args.indexOf(marker, from)
    if (at === -1) return false
    const before = at === 0 ? undefined : args[at - 1]
    const after = args[at + marker.length]
    const leftOk = before === undefined || MARKER_LEFT.test(before)
    const rightOk = after === undefined || MARKER_RIGHT.test(after)
    if (leftOk && rightOk) return true
    from = at + 1
  }
}

/**
 * 解析 `ps -Aww -o pid=,ppid=,args=` 的输出。内核线程的 args 形如 `[kthreadd]`，
 * 少数行 args 为空——两者都保留成行，只有 pid/ppid 不是正整数的行才丢弃。
 */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+([\s\S]*))?$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    rows.push({ pid, ppid, args: match[3] ?? '' })
  }
  return rows
}

/** pid 的祖先链（不含 pid 自身，也不含 init）。断链或成环都安全终止。 */
export function ancestorPids(table: readonly ProcessRow[], pid: number): number[] {
  const parents = new Map<number, number>()
  for (const row of table) parents.set(row.pid, row.ppid)
  const out: number[] = []
  const seen = new Set<number>([pid])
  let current = parents.get(pid)
  while (current !== undefined && current > 1 && !seen.has(current)) {
    seen.add(current)
    out.push(current)
    current = parents.get(current)
  }
  return out
}

/**
 * rootPids 及其全部子孙，按 pid 升序去重。断链的进程（如 ppid=1 的 daemon）不是任何
 * 已死根的子孙——这正是「父死了就找不回子树」的原因，也是需要签名匹配的动机。
 */
export function collectDescendants(
  table: readonly ProcessRow[],
  rootPids: readonly number[],
): number[] {
  const children = new Map<number, number[]>()
  for (const row of table) {
    const siblings = children.get(row.ppid)
    if (siblings === undefined) children.set(row.ppid, [row.pid])
    else siblings.push(row.pid)
  }
  const seen = new Set<number>()
  const queue = [...rootPids]
  while (queue.length > 0) {
    const current = queue.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    for (const child of children.get(current) ?? []) queue.push(child)
  }
  return [...seen].sort((a, b) => a - b)
}

export function planProcessSweep(
  table: readonly ProcessRow[],
  markers: readonly string[],
  options: PlanProcessSweepOptions = {},
): ProcessSweepPlan {
  if (markers.length === 0) return { pids: [], rows: [] }
  const excluded = new Set<number>(options.excludePids ?? [])
  for (const pid of collectDescendants(table, options.excludeSubtrees ?? [])) excluded.add(pid)
  const rows: ProcessRow[] = []
  for (const row of table) {
    if (row.pid <= 1 || excluded.has(row.pid)) continue
    if (markers.some((marker) => containsMarker(row.args, marker))) rows.push(row)
  }
  return { pids: rows.map((row) => row.pid), rows }
}

/**
 * 进程表快照。win32 返回空表（见文件头）；任何失败也返回空表——teardown 的卫生问题
 * 绝不能让一个本该通过的用例失败。
 */
export function readProcessTable(): ProcessRow[] {
  if (process.platform === 'win32') return []
  try {
    const stdout = execFileSync('ps', ['-Aww', '-o', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseProcessTable(stdout)
  } catch {
    return []
  }
}

/**
 * 真实清扫：快照 → 选择 → SIGKILL。自身与其祖先链只按 pid 排除，绝不排除它们的子树
 * ——runner 是所有 worker 的共同祖先，排除子树会让整个清扫失效。
 */
export function sweepProcesses(
  markers: readonly string[],
  options: SweepProcessesOptions = {},
): ProcessSweepPlan {
  const table = readProcessTable()
  if (table.length === 0) return { pids: [], rows: [] }
  const plan = planProcessSweep(table, markers, {
    excludePids: [...(options.excludePids ?? []), process.pid, ...ancestorPids(table, process.pid)],
    ...(options.excludeSubtrees !== undefined ? { excludeSubtrees: options.excludeSubtrees } : {}),
  })
  if (options.dryRun !== true) {
    for (const pid of plan.pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已经退出。
      }
    }
  }
  return plan
}

/** 非空计划的单行日志；空计划返回空串，调用方据此决定是否打印。 */
export function formatSweepLine(plan: ProcessSweepPlan, label: string): string {
  if (plan.pids.length === 0) return ''
  const detail = plan.rows.map((row) => `${row.pid} ${row.args.slice(0, 140)}`).join('\n  ')
  return `[e2e] 清扫 ${label} 的残留进程 ${plan.pids.length} 个：\n  ${detail}`
}
