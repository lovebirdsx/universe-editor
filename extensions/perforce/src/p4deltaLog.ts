/**
 * δ 的运行日志出口：一个独立的 `P4delta` OutputChannel + 一份按 runId 落盘的日志文件，两者
 * 逐行同步。`P4deltaService` 只把**已经格式化好**的行推过来（见 `p4deltaService` 的
 * `P4deltaLineSink`），本模块负责运行头、终态尾和落点路由。
 *
 * 为什么单独一个文件而不是塞进 `extension.ts`：这里是「频道怎么说话」的全部逻辑，可注入、可
 * 纯单测；`extension.ts` 只把它接到 `window.createOutputChannel` 与日志目录上。本文件**不在
 * `src/p4delta/` 下**——那一层不许 import `@universe-editor/extension-api`（见该目录
 * CLAUDE.md），而注入的正是宿主能力。
 *
 * 两条硬约束：
 * - 两个方法**绝不抛**（它们跑在 δ 的 data/close 回调里，宿主崩溃红线的射程内）。
 * - 频道与文件写的是同一批行：频道给「现在发生了什么」，文件给「刚才到底发生了什么」——
 *   一条只在频道里、另一条只在文件里，都会让排障的人对不上账。
 */
import type { OutputChannel } from '@universe-editor/extension-api'
import {
  formatArgvForLog,
  isoTimestampLocal,
  type P4deltaLineSink,
  type P4deltaLogSink,
  type P4deltaRunEnd,
  type P4deltaRunStart,
} from './p4delta/p4deltaService.js'
import type { P4deltaRunLog, P4deltaRunSession } from './p4delta/p4deltaRunLog.js'

export interface P4deltaLogSinkOptions {
  readonly channel: OutputChannel
  /** 专用日志目录；undefined = 没有存储目录，只剩频道（并给一次明确警告）。 */
  readonly store: P4deltaRunLog | undefined
  /** 警告出口（Perforce 频道的 log）。 */
  readonly warn: (msg: string) => void
  /**
   * 本会话 δ 引擎的来源（`resolveP4deltaEngine` 的 `source`），只写进运行头。取运行时值而
   * 不是构造时的快照：引擎重新配置（换 exe / 关掉）与 sink 无关，下一次运行的头才需要更新。
   */
  readonly engineSource?: () => string | undefined
}

/** 终态一行话：状态、退出码/信号、时长、记录数，以及为什么是这个状态。 */
export function describeP4deltaRunEnd(info: P4deltaRunEnd): string {
  const parts = [
    `exit ${info.code}`,
    info.signal !== null ? `signal ${info.signal}` : undefined,
    `${(info.elapsedMs / 1000).toFixed(3)}s`,
    `${info.records} record(s)`,
    `${info.progress} progress`,
  ].filter((part): part is string => part !== undefined)
  const note = info.note !== undefined && info.note !== '' ? ` — ${info.note}` : ''
  return `# ${info.status}: ${parts.join(', ')}${note}`
}

export function createP4deltaLogSink(options: P4deltaLogSinkOptions): P4deltaLogSink {
  const { channel, store, warn } = options
  const sessions = new Map<string, P4deltaRunSession>()
  let warned = false

  const emit = (session: P4deltaRunSession | undefined, line: string, footer = false): void => {
    const text = `${line}\n`
    try {
      channel.append(text)
    } catch {
      // 频道可能已经 dispose；落盘那一半照旧。
    }
    if (footer) session?.appendFooter(text)
    else session?.append(text)
  }

  return {
    open(info: P4deltaRunStart): P4deltaLineSink | undefined {
      const session = store?.beginRun(info.runId)
      if (session !== undefined) sessions.set(info.runId, session)
      else if (store === undefined && !warned) {
        warned = true
        warn(
          '[perforce] p4delta run logs are unavailable (no global storage); ' +
            'diagnostics are only in the P4delta output channel',
        )
      }
      const source = options.engineSource?.()
      // 运行头：一次运行自证身份所需的最小上下文。**不额外探测**——引擎版本不查、环境变量不
      // 带（可能有别处的凭据），路径与 argv 已经是这台机器上最直白的定位信息。
      const header = [
        '',
        `=== p4delta run ${info.runId} ===`,
        `# started ${isoTimestampLocal(info.startedAt)}`,
        `# engine  ${info.exe}${source !== undefined ? ` (${source})` : ''}`,
        `# client  ${info.clientRoot}`,
        `# cwd     ${info.cwd}`,
        `# argv    ${formatArgvForLog(info.args)}`,
      ]
      for (const line of header) emit(session, line)
      return {
        line(text: string): void {
          emit(sessions.get(info.runId), text)
        },
      }
    },

    close(info: P4deltaRunEnd): void {
      const session = sessions.get(info.runId)
      sessions.delete(info.runId)
      // 终态走 footer：正文预算用尽时它仍然写得进去（尾部预留就是为它留的），否则被截断的
      // 日志会以「没有任何结论」的样子留在盘上。
      emit(session, describeP4deltaRunEnd(info), true)
      // 命令统计也走 footer：一次宽 get 的正文被截断后，这条摘要仍在末尾，答得出「这 N 次
      // 调用花在哪」。它**不是** summary 记录的复读（那条已实时进了频道）——只是有界摘要。
      if (info.summary !== undefined && info.summary !== '') emit(session, info.summary, true)
      const dropped = session?.dropped
      if (dropped !== undefined && dropped.lines > 0) {
        // 丢过东西就要说：一份缺行的日志看起来和完整的一样。
        emit(
          session,
          `# dropped ${dropped.lines} line(s) / ${dropped.bytes} byte(s)` +
            `${dropped.truncated ? ' (file budget exhausted)' : ' (writer behind)'}`,
          true,
        )
      }
      if (session !== undefined && store !== undefined) {
        // 有界收尾：`.writing` 由 close 自己翻成 `.log`，随后才从活动表里摘掉。**但这条链可能在
        // 超时后就落定**（close 的 promise 允许先 resolve，后台才把队列写完并改名）——摘早了不
        // 丢东西：那一刻盘上还是 `.writing`，`_scan` 照样列得出它，清理也按 24h 保护着。
        void session.close('').then(() => store.releaseRun(info.runId))
      }
    },
  }
}
