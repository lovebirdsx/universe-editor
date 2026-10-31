import * as nodeChildProcess from 'node:child_process'

/**
 * 一个可以被终止的子进程。只要 pid 与 kill，不要求完整的 ChildProcess，
 * 测试里的假子进程也能直接传进来。
 */
export interface KillableProcess {
  readonly pid?: number | undefined
  kill(): unknown
}

/** 低层策略：按 pid 启动一次树杀；失败时调用 fallback。 */
export type TreeKiller = (pid: number, fallback: () => void) => void

/** 服务层的注入点（测试用）。 */
export type ProcessKiller = (proc: KillableProcess) => void

export interface KillProcessTreeOptions {
  platform?: NodeJS.Platform
  killTree?: TreeKiller
  /** 回退路径的诊断出口；回调抛错会被吞掉。 */
  log?: (message: string) => void
}

/** taskkill 不应拖住取消动作；超时后按失败回退到 kill()。 */
const TASKKILL_TIMEOUT_MS = 5000

/**
 * execFile 的回调是异步的：日志写入抛错会冒泡成宿主的 uncaughtException
 * （perforce 红线 4）。日志永远只是 best-effort。
 */
function note(log: ((message: string) => void) | undefined, message: string): void {
  try {
    log?.(message)
  } catch {
    // best-effort
  }
}

function killDirect(proc: KillableProcess): void {
  try {
    proc.kill()
  } catch {
    // 已经退出了；close 处理器会照常收敛结果。
  }
}

/**
 * Windows 的 `ChildProcess.kill()` 是 TerminateProcess：只终止直接子进程。
 * p4delta 自己 spawn 的 p4 会因此变成孤儿；`taskkill /T` 按父 PID 树递归，
 * 正好补上这一层。
 *
 * 刻意**不**在启动 taskkill 后立刻 `proc.kill()`：父进程先死会让 `/T` 枚举时
 * 子树已断，正是要修的孤儿来源。只有 taskkill 自己失败时才回退。
 *
 * 用命名空间 + 惰性访问而不是顶层解构：仓库里大量单测把 `node:child_process`
 * 整体 mock 成只导出 `spawn` 的对象，静态解构会在模块求值阶段就抛错。
 */
function taskkill(pid: number, fallback: () => void, log?: (message: string) => void): void {
  let candidate: unknown
  try {
    candidate = (nodeChildProcess as { execFile?: unknown }).execFile
  } catch {
    note(log, 'taskkill unavailable (execFile lookup threw); falling back to proc.kill()')
    fallback()
    return
  }
  if (typeof candidate !== 'function') {
    note(log, 'taskkill unavailable (no execFile); falling back to proc.kill()')
    fallback()
    return
  }

  const execFile = candidate as typeof nodeChildProcess.execFile
  try {
    execFile(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
      (error) => {
        if (error) {
          // 旧版 p4delta 没有 Job、或 taskkill 被 EDR 拦截时，这一行是唯一能解释
          // 「为什么取消后仍有残留 p4」的现场证据。
          note(log, `taskkill ${pid} failed (${error.message}); falling back to proc.kill()`)
          fallback()
        }
      },
    )
  } catch (error) {
    note(log, `taskkill ${pid} could not start (${String(error)}); falling back to proc.kill()`)
    fallback()
  }
}

/**
 * 终止 `proc` 及其后代。Windows 走 `taskkill /T /F`，其余平台与所有失败路径
 * 都回退到 `proc.kill()`。永不向外抛：调用点在异步回调里，异常会冒泡成
 * extension host 的 uncaughtException。
 */
export function killProcessTree(proc: KillableProcess, options: KillProcessTreeOptions = {}): void {
  const platform = options.platform ?? process.platform
  const pid = proc.pid
  if (platform !== 'win32' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    killDirect(proc)
    return
  }

  const log = options.log
  const killTree = options.killTree ?? ((treePid, fallback) => taskkill(treePid, fallback, log))
  try {
    killTree(pid, () => killDirect(proc))
  } catch {
    killDirect(proc)
  }
}

/** killer 自身失败不向外抛；调用点都在异步回调里，close 处理器照常收敛结果。 */
export function killQuietly(proc: KillableProcess, killProcess: ProcessKiller): void {
  try {
    killProcess(proc)
  } catch {
    // 已经退出了。
  }
}
