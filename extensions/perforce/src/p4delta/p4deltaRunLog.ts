/**
 * 磁盘上的 δ 运行日志：**每个 run 一个文件**，实时追加，独立于宿主的日志设施。
 *
 * 为什么自包含而不是复用 `apps/editor` 的 `FileLogger`：那一份依赖 Electron 与主进程的
 * 日志服务，扩展宿主里够不着；而这里要的东西（有界队列、单文件上限、保留策略、活动文件
 * 保护）又必须和「哪个进程在写哪个文件」绑在一起。纯 Node、依赖全部注入（根目录 + 告警
 * 回调），所以既能在 extension host 里跑，也能纯单测。
 *
 * 三条不会让步的性质：
 * - **有界**：待写队列按字节封顶（超了丢行并留标记），单文件按字节封顶（截断并留标记），
 *   绝不用「无限个 Promise 排队」当缓冲。写盘串行、批量追加，绝不逐行 fsync。
 * - **不拖死调用方**：`close()` 有有限等待（磁盘卡住时不会把同步挂住），任何 fs 异常都只
 *   变成一次告警。
 * - **跨窗口各写各的**：运行中的文件带 `.writing` 后缀，结束时 rename 成 `.log`；清理只动
 *   专用目录里符合命名规范、且**已结束**的文件，遗留的 `.writing` 要超过保守期限才删——
 *   另一个窗口可能正往里写。
 *
 * 读取一律先过 runId 校验与专用目录前缀校验，并拒绝符号链接，绝不做任意路径读取；快照是
 * **有界头 + 尾**读（省略标记算进预算、UTF-8 边界完整、保留末尾终态），不整读文件再切。
 */
import { appendFile, lstatSync, mkdirSync, readdirSync, rename, unlinkSync } from 'node:fs'
import { open as openFile, type FileHandle } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** 一行的格式由调用方决定（本模块只管字节），这里只封顶。 */
const COMPLETED_SUFFIX = '.log'
const ACTIVE_SUFFIX = '.log.writing'

/** runId 的形状：文件名安全的短标识，也是读取路径的唯一入口。 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isSafeRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId)
}

/**
 * 上限与保留策略。全部可注入：单测要能在几百字节的量级上验证截断、丢行和淘汰，
 * 而生产值（10 MiB / 1 MiB / 7 天 / 200 个 / 100 MiB）写一遍就要几百 MiB 磁盘。
 */
export interface P4deltaRunLogLimits {
  /** 单文件硬上限：正文 + 截断标记 + footer 三者相加不超过它，在飞的那一块也算数。 */
  readonly maxFileBytes: number
  /** 尾部预留：终态行（`appendFooter`）的字节上限，超出按字节丢弃并计数。 */
  readonly footerReserveBytes: number
  /** 待写队列上限：超了丢行（有标记），绝不把内存当磁盘用。 */
  readonly maxQueuedBytes: number
  /** 批量落盘周期。逐行写盘的代价（每次一个 syscall）在一条宽 get 上会盖过同步本身。 */
  readonly flushIntervalMs: number
  /** `close()` 的有限等待上限：超过就让调用方先走，后台仍把队列串行写完并改名。 */
  readonly closeTimeoutMs: number
  readonly maxAgeMs: number
  readonly maxFiles: number
  readonly maxTotalBytes: number
  /** 遗留 `.writing` 的保守期限：另一个窗口可能还在写，只有明显陈旧才动手。 */
  readonly activeGraceMs: number
  /** 清理节流：每个进程至多这么久清一次。 */
  readonly cleanupThrottleMs: number
  /** 快照读取上限：日志是给人看的，不需要把整个文件灌进编辑器。 */
  readonly maxSnapshotBytes: number
}

export const P4DELTA_RUN_LOG_LIMITS: P4deltaRunLogLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  footerReserveBytes: 64 * 1024,
  maxQueuedBytes: 1024 * 1024,
  flushIntervalMs: 200,
  closeTimeoutMs: 2000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxFiles: 200,
  maxTotalBytes: 100 * 1024 * 1024,
  activeGraceMs: 24 * 60 * 60 * 1000,
  cleanupThrottleMs: 10 * 60 * 1000,
  maxSnapshotBytes: 2 * 1024 * 1024,
}

/** 一个已结束（或正在写）的 run 日志文件。 */
export interface P4deltaRunLogFile {
  readonly runId: string
  readonly file: string
  readonly bytes: number
  /** mtime（epoch ms）：结束时被 rename，等于那次结束的时刻。 */
  readonly at: number
  /** 另一个窗口（或本次崩溃）留下的 `.writing` 文件，内容不完整。 */
  readonly active: boolean
}

/** 打开一份日志快照的结果。 */
export interface P4deltaRunLogSnapshot {
  readonly runId: string
  readonly text: string
  /** 读取上限切掉了尾部。 */
  readonly truncated: boolean
  /** 快照取自仍在写入的文件：内容可能还在增长。 */
  readonly active: boolean
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))}MiB`
  if (n >= 1024) return `${Math.round(n / 1024)}KiB`
  return `${n}B`
}

/** 快照被截断时的省略标记；它的字节数也计入 `maxSnapshotBytes`。 */
const SNAPSHOT_TRUNCATION = '\n… (truncated)\n'

/**
 * 写盘原语的最小注入面。存在的唯一理由是单测要能**确定性地**制造「写在飞 / 回调何时释放」，
 * 而不是靠 sleep 猜时序；生产路径用 Node 的 `appendFile`。
 */
export interface P4deltaRunLogIo {
  append(file: string, text: string, onDone: (err: NodeJS.ErrnoException | null) => void): void
}

const DEFAULT_P4DELTA_RUN_LOG_IO: P4deltaRunLogIo = {
  append: (file, text, onDone) => appendFile(file, text, 'utf8', onDone),
}

/** 从 `position` 起读最多 `length` 字节（并发增长时可能更少）。 */
async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let off = 0
  while (off < length) {
    const { bytesRead } = await handle.read(buf, off, length - off, position + off)
    if (bytesRead <= 0) break
    off += bytesRead
  }
  return buf.subarray(0, off)
}

/** head 片段里最后一个**完整** UTF-8 码点的结束位置（切在码点中间就回退到它的起点）。 */
function utf8HeadEnd(buf: Buffer): number {
  const n = buf.length
  if (n === 0) return 0
  let i = n - 1
  let cont = 0
  while (i >= 0 && cont < 3 && (buf[i]! & 0xc0) === 0x80) {
    i -= 1
    cont += 1
  }
  if (i < 0) return 0
  const lead = buf[i]!
  const len = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0
  if (len === 0) return i // 非法首字节：切在它之前
  return i + len <= n ? n : i
}

/** tail 片段里第一个完整 UTF-8 码点的起始位置（开头是续字节就当它属于被切掉的那个码点）。 */
function utf8TailStart(buf: Buffer): number {
  let i = 0
  while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i += 1
  return i
}

/**
 * 一次运行的写入会话。`append` 永不抛、永不阻塞；`close` 返回的 promise 只在**有界等待**
 * 内落定，调用方可以完全忽略它。
 *
 * 写入是一条串行链：同一时刻只有一个 `appendFile` 在飞，回调里决定接着排下一批；`close()`
 * 只把「不再接受正文、把队列写完、再 rename」标出来，**不自己同步补写**——磁盘一卡就同步写
 * 会堵住 extension host，超时 rename 也可能赶在在途写之前。超时只是让调用方先拿到 promise，
 * 后台照旧串行完成；没收尾完的 `.writing` 绝不改名为 `.log`。
 */
export class P4deltaRunSession {
  private _queue: string[] = []
  private _queuedBytes = 0
  private _inflightBytes = 0
  private _writtenBytes = 0
  private _footerBytes = 0
  private _droppedBytes = 0
  private _droppedLines = 0
  private _truncatedMarked = false
  private _bodyClosed = false
  private _closed = false
  private _failed = false
  private _writing = false
  private _finishingClose = false
  private _settled = false
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _finished: Promise<void> | undefined

  constructor(
    readonly runId: string,
    private readonly _activeFile: string,
    private readonly _finalFile: string,
    private readonly _warn: (msg: string) => void,
    private readonly _limits: P4deltaRunLogLimits = P4DELTA_RUN_LOG_LIMITS,
    private readonly _io: P4deltaRunLogIo = DEFAULT_P4DELTA_RUN_LOG_IO,
  ) {}

  /** 真实写盘字节数（不含被丢弃的）。 */
  get writtenBytes(): number {
    return this._writtenBytes
  }

  /** 已确认落盘 + 在飞 + 已排队的字节：单文件预算必须按这个总量算，在飞块不是空位。 */
  private _usedBytes(): number {
    return this._writtenBytes + this._inflightBytes + this._queuedBytes
  }

  private get _truncationMarker(): string {
    return (
      `[p4delta] log truncation: this run exceeded ${formatBytes(this._limits.maxFileBytes)}; ` +
      'the rest of the run’s output is not recorded in this file.\n'
    )
  }

  /** 正文预算：单文件上限减去 footer 预留与截断标记（三者相加恰好不超过上限）。 */
  private get _bodyBudget(): number {
    return (
      this._limits.maxFileBytes -
      this._limits.footerReserveBytes -
      Buffer.byteLength(this._truncationMarker, 'utf8')
    )
  }

  /**
   * 追加一行（调用方自带换行）。正文超出单文件预算后只留一次截断标记，之后的行按字节
   * 丢弃并计数——**丢的东西要有痕迹**，否则一份被截断的日志看起来就是完整的。
   */
  append(text: string): void {
    if (text === '' || this._failed || this._closed) return
    const bytes = Buffer.byteLength(text, 'utf8')
    if (this._bodyClosed) {
      this._countDropped(bytes, true)
      return
    }
    if (this._usedBytes() + bytes > this._bodyBudget) {
      this._bodyClosed = true
      this._countDropped(bytes, true)
      const marker = this._truncationMarker
      if (Buffer.byteLength(marker, 'utf8') <= this._limits.maxFileBytes) this._enqueue(marker)
      this._schedule(0)
      return
    }
    if (this._queuedBytes + bytes > this._limits.maxQueuedBytes) {
      // The writer is behind (a slow disk). Drop rather than grow the queue.
      this._countDropped(bytes, false)
      return
    }
    this._enqueue(text)
    // Half full: don't wait out the interval before draining.
    this._schedule(
      this._queuedBytes * 2 > this._limits.maxQueuedBytes ? 0 : this._limits.flushIntervalMs,
    )
  }

  /**
   * 追加一行**终态**内容：即使正文已截断也要写进去（尾部预留就是为它留的）。预留是有界的——
   * 放不下的终态行按字节丢弃并计数，绝不因为一行 footer 就把文件撑过上限。
   */
  appendFooter(text: string): void {
    if (this._failed || text === '' || this._closed) return
    const bytes = Buffer.byteLength(text, 'utf8')
    if (this._footerBytes + bytes > this._limits.footerReserveBytes) {
      this._countDropped(bytes, true)
      return
    }
    this._footerBytes += bytes
    this._enqueue(text)
    this._pump()
  }

  /** 有界地把队列写下去（打开活动日志前调用，免得快照缺掉最后一段）。 */
  async flushNow(timeoutMs = this._limits.closeTimeoutMs): Promise<void> {
    if (this._failed || this._closed) return
    this._drain()
    await this._waitForIdle(timeoutMs)
  }

  /**
   * 收尾：补终态行、有界落盘、把 `.writing` 换成 `.log`。幂等，永不抛。
   *
   * 超时只让**调用方**先走（后台仍把队列写完再 rename）；没收尾完就保留 `.writing`，绝不
   * 冒称 complete。任何一步都没有同步补写的逃生口。
   */
  close(footer: string): Promise<void> {
    if (this._finished !== undefined) return this._finished
    this._finished = this._close(footer)
    return this._finished
  }

  private async _close(footer: string): Promise<void> {
    if (this._failed) return
    if (footer !== '') this.appendFooter(footer)
    this._closed = true
    if (this._timer !== undefined) {
      clearTimeout(this._timer)
      this._timer = undefined
    }
    this._pump()
    await this._waitForClose(this._limits.closeTimeoutMs)
  }

  private _schedule(delay: number): void {
    if (this._failed) return
    if (this._timer !== undefined) {
      // An already-armed timer only needs re-arming when this call asks for an
      // earlier flush than the one pending.
      if (delay > 0) return
      clearTimeout(this._timer)
    }
    this._timer = setTimeout(() => {
      this._timer = undefined
      this._drain()
    }, delay)
    this._timer.unref?.()
  }

  private _enqueue(text: string): void {
    this._queue.push(text)
    this._queuedBytes += Buffer.byteLength(text, 'utf8')
  }

  private _countDropped(bytes: number, markTruncated: boolean): void {
    this._droppedBytes += bytes
    this._droppedLines += 1
    if (markTruncated) this._truncatedMarked = true
  }

  /**
   * 串行落盘的中枢：没在飞就写一批，写完了接着排/收尾。**没有 `_finished` 早退**——关闭期间
   * 恰恰要靠它把后续队列接着写下去。
   */
  private _pump(): void {
    if (this._failed || this._writing) return
    if (this._queue.length > 0) {
      this._drain()
      return
    }
    if (this._closed) this._finishClose()
  }

  /** 串行落盘：同一时刻只有一个 append 在飞，回调里再决定要不要接着排。 */
  private _drain(): void {
    if (this._writing || this._failed) return
    if (this._queue.length === 0) return
    const chunk = this._queue.join('')
    const bytes = this._queuedBytes
    this._queue = []
    this._queuedBytes = 0
    if (chunk === '') return
    this._writing = true
    this._inflightBytes = bytes
    try {
      this._io.append(this._activeFile, chunk, (err) => {
        this._writing = false
        this._inflightBytes = 0
        if (err) {
          this._fail(err)
          return
        }
        this._writtenBytes += bytes
        if (this._closed) this._pump()
        else if (this._queue.length > 0) this._schedule(0)
      })
    } catch (err) {
      // An injected writer that throws synchronously is still just a write failure.
      this._writing = false
      this._inflightBytes = 0
      this._fail(err)
    }
  }

  /** 队列真空了（且已关闭）才改名：`.writing` → `.log` 就是「这一跑结束了」的全部凭据。 */
  private _finishClose(): void {
    if (this._finishingClose || this._settled || this._failed) return
    this._finishingClose = true
    rename(this._activeFile, this._finalFile, (err) => {
      this._settled = true
      if (err) this._fail(err)
    })
  }

  private async _waitForIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this._queue.length > 0 || this._writing) {
      if (Date.now() >= deadline) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  /** 等「收尾完成或失败」，超时就让调用方先走（后台继续）。 */
  private async _waitForClose(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this._settled && !this._failed) {
      if (Date.now() >= deadline) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  private _fail(err: unknown): void {
    if (this._failed) return
    this._failed = true
    this._queue = []
    this._queuedBytes = 0
    this._inflightBytes = 0
    this._warn(`[perforce] p4delta run log write failed: ${(err as Error).message}`)
  }

  /** 截断 / 丢弃的痕迹，测试与终态行据此如实播报「这份日志不完整」。 */
  get dropped(): { readonly bytes: number; readonly lines: number; readonly truncated: boolean } {
    return {
      bytes: this._droppedBytes,
      lines: this._droppedLines,
      truncated: this._truncatedMarked,
    }
  }
}

/**
 * 专用目录 + 保留策略。一个进程一个实例（`SyncHistoryLog` 同款），所有实例指向同一个目录，
 * 各自只写自己的文件。
 */
export class P4deltaRunLog {
  private readonly _activeSessions = new Map<string, P4deltaRunSession>()
  private _lastCleanupAt = 0
  private _warned = false

  private constructor(
    private readonly _root: string,
    private readonly _warnSink: (msg: string) => void,
    private readonly _limits: P4deltaRunLogLimits,
    private readonly _io: P4deltaRunLogIo,
  ) {}

  /**
   * 打开（必要时创建）日志目录。没有存储目录、目录建不出来、或根目录是个符号链接时返回
   * undefined——调用方据此降级为「只有输出频道」。**根是符号链接一律拒绝**：目录之外
   * 的写入和读取都超出本模块能担保的范围。
   *
   * `io` 只给单测用（默认走 Node 的 `appendFile`）。
   */
  static open(
    root: string,
    warn?: (msg: string) => void,
    limits: P4deltaRunLogLimits = P4DELTA_RUN_LOG_LIMITS,
    io: P4deltaRunLogIo = DEFAULT_P4DELTA_RUN_LOG_IO,
  ): P4deltaRunLog | undefined {
    if (!root) return undefined
    const sink = (msg: string): void => {
      try {
        warn?.(msg)
      } catch {
        // 调用方的告警口不是我们能信的。
      }
    }
    try {
      mkdirSync(root, { recursive: true })
      const st = lstatSync(root)
      if (!st.isDirectory() || st.isSymbolicLink()) return undefined
    } catch {
      return undefined
    }
    return new P4deltaRunLog(resolve(root), sink, limits, io)
  }

  get root(): string {
    return this._root
  }

  /** 本次进程内仍在写的 runId（`openLog` 据此判定「快照」还是「完整」）。 */
  get activeRunIds(): readonly string[] {
    return [...this._activeSessions.keys()]
  }

  /** 起一个 run 的日志文件。`runId` 必须已经过 {@link isSafeRunId}。 */
  beginRun(runId: string): P4deltaRunSession | undefined {
    if (!isSafeRunId(runId)) return undefined
    const existing = this._activeSessions.get(runId)
    if (existing !== undefined) return existing
    const session = new P4deltaRunSession(
      runId,
      this._fileOf(runId, true),
      this._fileOf(runId, false),
      (msg) => this._warnOnce(msg),
      this._limits,
      this._io,
    )
    this._activeSessions.set(runId, session)
    this.cleanup()
    return session
  }

  /** 会话结束时调用：把 runId 从活动表里摘掉（文件已经 rename 走）。 */
  releaseRun(runId: string): void {
    this._activeSessions.delete(runId)
    this.cleanup()
  }

  /**
   * 最近的运行（新到旧），已结束与仍在写的混在一起。**不按「是否已结束」分档**：命令叫「打开
   * 最近一次日志」，一次刚起、还在写的运行就是最近的那一次，把它压到已结束的后面会让这条命令
   * 打开上一次的日志。活动文件的内容只是还在长，快照读取自己会先做有界 flush。
   */
  list(max: number): P4deltaRunLogFile[] {
    const files = this._scan()
    // 本进程正在写、但还没有落过盘的运行在目录里看不到——它同样是「一次运行」，必须一起
    // 列出来（否则「打开最近一次日志」会在运行刚开始时答「没有日志」）。
    const seen = new Set(files.map((f) => f.runId))
    for (const runId of this._activeSessions.keys()) {
      if (seen.has(runId)) continue
      files.push({
        runId,
        file: this._fileOf(runId, true),
        bytes: 0,
        at: Date.now(),
        active: true,
      })
    }
    files.sort((a, b) => b.at - a.at)
    return files.slice(0, Math.max(0, max))
  }

  /** 目录里最近的一次运行，或 undefined（一个都没有 / 目录读不了）。 */
  latest(): P4deltaRunLogFile | undefined {
    return this.list(1)[0]
  }

  /**
   * 读一份日志快照。路径先过 runId 形状校验、再过专用目录前缀校验，然后拒绝符号链接、
   * fstat 确认是普通文件：调用方传进来的 id 永远不能变成一个任意路径。
   *
   * 读取是**真正有界**的：只读头一段与尾一段再拼起来（省略标记算进预算），绝不 `readFileSync`
   * 把整个文件灌进内存再切——日志可能长到 10 MiB，而快照预算只有 2 MiB。只取头会让「打开
   * 最近一次日志」永远看不到结论，所以尾巴必须留着：终态行写在文件末尾。切点落在 UTF-8
   * 码点中间时回退到边界，免得中文字符渲染成替换字符。
   *
   * 仍在写的运行先做一次**有界 flush**，否则「打开运行中的日志」只能看到上一次批量落盘的
   * 位置。
   */
  async readSnapshot(runId: string): Promise<P4deltaRunLogSnapshot | undefined> {
    if (!isSafeRunId(runId)) return undefined
    const live = this._activeSessions.get(runId)
    if (live !== undefined) await live.flushNow()
    for (const active of [true, false]) {
      const read = await this._readSnapshotFile(this._fileOf(runId, active))
      if (read === undefined) continue
      return { runId, text: read.text, truncated: read.truncated, active }
    }
    return undefined
  }

  /**
   * 保留策略。节流（每进程十分钟一次）且**只动已结束的文件**：运行中的 `.writing` 只有在
   * 超过保守期限时才当作崩溃遗留清掉——另一个窗口正在写的那个文件不是我们的垃圾。
   *
   * 按 mtime 从新到旧裁：既满足「超过 200 个 / 100 MiB 就删最旧的」，也让删除顺序与
   * readdir 的任意顺序无关。
   */
  cleanup(): void {
    const now = Date.now()
    if (now - this._lastCleanupAt < this._limits.cleanupThrottleMs) return
    this._lastCleanupAt = now
    try {
      const keep: P4deltaRunLogFile[] = []
      for (const entry of this._scan()) {
        if (entry.active) {
          if (now - entry.at > this._limits.activeGraceMs) this._unlink(entry.file)
          continue
        }
        if (now - entry.at > this._limits.maxAgeMs) {
          this._unlink(entry.file)
          continue
        }
        keep.push(entry)
      }
      keep.sort((a, b) => b.at - a.at)
      let total = 0
      for (let i = 0; i < keep.length; i++) {
        const entry = keep[i]
        if (entry === undefined) continue
        total += entry.bytes
        if (i >= this._limits.maxFiles || total > this._limits.maxTotalBytes) {
          this._unlink(entry.file)
        }
      }
    } catch {
      this._warnOnce('[perforce] p4delta log cleanup failed; older run logs will stay longer')
    }
  }

  /** 目录里所有符合命名规范的文件（含活动文件）。读不了就是空。 */
  private _scan(): P4deltaRunLogFile[] {
    const out: P4deltaRunLogFile[] = []
    let names: string[]
    try {
      names = readdirSync(this._root)
    } catch {
      return out
    }
    for (const name of names) {
      const active = name.endsWith(ACTIVE_SUFFIX)
      const runId = active
        ? name.slice(0, -ACTIVE_SUFFIX.length)
        : name.endsWith(COMPLETED_SUFFIX)
          ? name.slice(0, -COMPLETED_SUFFIX.length)
          : undefined
      if (runId === undefined || !isSafeRunId(runId)) continue
      const file = join(this._root, name)
      try {
        const st = lstatSync(file)
        if (!st.isFile() || st.isSymbolicLink()) continue
        out.push({ runId, file, bytes: st.size, at: st.mtimeMs, active })
      } catch {
        // 竞态（另一窗口刚删/刚 rename）——跳过。
      }
    }
    return out
  }

  private _fileOf(runId: string, active: boolean): string {
    return join(this._root, `${runId}${active ? ACTIVE_SUFFIX : COMPLETED_SUFFIX}`)
  }

  /**
   * 专用目录前缀校验 + 符号链接拒绝 + fstat 普通文件校验，然后按 `maxSnapshotBytes` 预算
   * **有界**地读：放得下就整读，放不下就头 + 省略标记 + 尾。上限由本方法套用，调用方无需再切。
   */
  private async _readSnapshotFile(
    file: string,
  ): Promise<{ readonly text: string; readonly truncated: boolean } | undefined> {
    if (!file.startsWith(this._root + sep)) return undefined
    try {
      const st = lstatSync(file)
      if (!st.isFile() || st.isSymbolicLink()) return undefined
    } catch {
      return undefined
    }
    let handle: FileHandle
    try {
      handle = await openFile(file, 'r')
    } catch {
      return undefined
    }
    try {
      const st = await handle.stat()
      if (!st.isFile()) return undefined
      const budget = this._limits.maxSnapshotBytes
      const size = st.size
      if (size <= budget) {
        const buf = await readRange(handle, 0, size)
        return { text: buf.toString('utf8'), truncated: false }
      }
      const markerBytes = Buffer.byteLength(SNAPSHOT_TRUNCATION, 'utf8')
      if (budget <= markerBytes) {
        // 预算连省略标记都放不下：只读一段头，连标记一起算在预算内。
        const head = await readRange(handle, 0, budget)
        return { text: head.subarray(0, utf8HeadEnd(head)).toString('utf8'), truncated: true }
      }
      const room = budget - markerBytes
      const headLen = Math.floor(room / 2)
      const tailLen = room - headLen
      const head = await readRange(handle, 0, headLen)
      const tail = await readRange(handle, size - tailLen, tailLen)
      const headText = head.subarray(0, utf8HeadEnd(head)).toString('utf8')
      const tailText = tail.subarray(utf8TailStart(tail)).toString('utf8')
      return { text: `${headText}${SNAPSHOT_TRUNCATION}${tailText}`, truncated: true }
    } catch {
      return undefined
    } finally {
      await handle.close().catch(() => {
        // 读已经拿到了；关不掉句柄不是这里的失败。
      })
    }
  }

  private _unlink(file: string): void {
    try {
      unlinkSync(file)
    } catch {
      // 已经被别的窗口删掉 / 被占用：留着就是下一次清理的事。
    }
  }

  private _warnOnce(msg: string): void {
    if (this._warned) return
    this._warned = true
    this._warnSink(msg)
  }
}

/** 供测试与调用方构造 runId：时间 + pid + 进程内序号 + 随机段（跨窗口唯一）。 */
let runSeq = 0
export function nextP4deltaRunId(at: number, random: () => number = Math.random): string {
  runSeq += 1
  const tail = Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
  return `p4d-${at}-${process.pid}-${runSeq}-${tail}`
}
