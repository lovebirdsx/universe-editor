/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  上一会话死因的唯一收口处。
 *
 *  两个证人：Windows 事件日志（崩溃/挂起记录 vs. 非致命预警）与本会话自己的指标尾巴
 *  （日志停止前什么在涨）。只有真正的崩溃/挂起记录才升级成原生死亡——内存增长预警只是
 *  前兆，把它当证据会盖掉「日志里根本没有崩溃记录」这条信息。没有 dump 又没有崩溃记录
 *  时一律未定论：事件日志读不到是「不知道」，读到了但没匹配也是「不知道」，两者都不足
 *  以指认外部终止（WER 未被记录、机器关机/重启都会留下同样的现场），只是措辞分开写。
 *--------------------------------------------------------------------------------------------*/

import {
  describeExitScene,
  SESSION_DIR_NAME_RE,
  type ExitScene,
  type SceneProcess,
} from './exitSceneForensics.js'
import {
  describeWerEvent,
  isNativeDeathEvidence,
  type WerEventKind,
  type WerEventSummary,
} from './werForensics.js'

export interface ForensicsLine {
  readonly level: 'error' | 'warn' | 'info'
  readonly text: string
}

export interface AbnormalExitFacts {
  readonly crashDumpCount: number
  readonly platform: string
  /** undefined = the event log could not be read; [] = read, nothing matched. */
  readonly werEvents: readonly WerEventSummary[] | undefined
  readonly scene: ExitScene | undefined
  readonly previousSessionId: string
  readonly lastAliveAt: number
}

export type AbnormalExitVerdict = 'native-death' | 'indeterminate'

export interface AbnormalExitConclusion {
  readonly verdict: AbnormalExitVerdict
  readonly lines: readonly ForensicsLine[]
  /** Classification-only payload for the error sink — no timestamps, sizes or paths. */
  readonly record: string
}

function describeWerSummary(kinds: readonly WerEventKind[]): string {
  if (kinds.length === 0) return 'none'
  return [...new Set(kinds)].sort().join('+')
}

function describeSceneSummary(scene: ExitScene | undefined): string {
  if (!scene) return 'unavailable'
  const rendererOver = scene.renderers.some((process) => process.flaggedSamples > 0)
  if (rendererOver) return 'renderer-over-threshold'
  if (scene.hosted.some((process) => process.flaggedSamples > 0)) return 'hosted-over-threshold'
  return 'calm'
}

/**
 * 内存曲线只是现场事实，不能写成死因。「末尾仍在线之上」的判据是**末次读数 > 阈值**，
 * 不是「曾被标记过」：2026-09-12 那次被标记的 renderer 已在日志停止前四分钟从 2747MB
 * 回落到 687MB，只读 flaggedSamples 会把复盘引向一个数据不支持的 OOM 归因。
 */
function describeHeavyProcess(process: SceneProcess): string {
  const subject =
    process.type === 'Tab'
      ? `renderer pid ${process.pid}${process.window === undefined ? '' : ` (window-${process.window})`}`
      : `${process.name ?? 'a spawned process'}#${process.pid}`
  const line = `${process.thresholdMB ?? '?'}MB line`
  if (process.thresholdMB !== undefined && process.lastMB > process.thresholdMB) {
    return `our own log shows ${subject} peaked at ${process.peakMB}MB and was still over its ${line} in the last sample`
  }
  return `our own log shows ${subject} peaked at ${process.peakMB}MB while over its ${line}, but the final sample read ${process.lastMB}MB — it had come back under the line, so the peak does not explain the exit`
}

/** The id is read back from a JSON file on disk — only a well-formed name is echoed into the log. */
function sessionLabel(sessionId: string): string {
  return SESSION_DIR_NAME_RE.test(sessionId) ? sessionId : 'unknown session'
}

export function concludeAbnormalExit(facts: AbnormalExitFacts): AbnormalExitConclusion {
  const werEvents = facts.werEvents ?? []
  const evidence = werEvents.filter((event) => isNativeDeathEvidence(event.kind))
  const precursors = werEvents.filter((event) => event.kind === 'leak-warning')
  const rest = werEvents.filter((event) => event.kind === 'other')

  const lines: ForensicsLine[] = []
  for (const event of evidence) lines.push({ level: 'error', text: describeWerEvent(event) })
  for (const event of precursors) {
    lines.push({
      level: 'warn',
      text: `precursor (not crash evidence): ${describeWerEvent(event)}`,
    })
  }
  for (const event of rest)
    lines.push({ level: 'info', text: `informational: ${describeWerEvent(event)}` })

  const heavyRenderer = facts.scene?.renderers.find((process) => process.flaggedSamples > 0)
  const heavyHosted = facts.scene?.hosted.find((process) => process.flaggedSamples > 0)
  if (facts.scene) {
    lines.push({
      level: heavyRenderer || heavyHosted ? 'warn' : 'info',
      text: describeExitScene(facts.scene, { lastAliveAt: facts.lastAliveAt }),
    })
  } else {
    lines.push({
      level: 'warn',
      text: `previous-session log tail unavailable (${sessionLabel(facts.previousSessionId)}) — no memory curve for the final minutes`,
    })
  }

  const verdict: AbnormalExitVerdict =
    facts.crashDumpCount > 0 || evidence.length > 0 ? 'native-death' : 'indeterminate'

  if (verdict === 'native-death') {
    const kinds = describeWerSummary(evidence.map((event) => event.kind))
    lines.push({
      level: 'error',
      text:
        facts.crashDumpCount > 0
          ? `crash dump found for the previous session — the process died natively`
          : `native crash/hang recorded for this exe in the Windows Application log (${kinds}) — the session died inside this process, not from an external kill`,
    })
  } else if (facts.werEvents === undefined) {
    // 没查成：不知道，别把查询失败渲染成「外部终止」
    lines.push({
      level: 'warn',
      text:
        facts.platform === 'win32'
          ? 'Windows Application log could not be read (wevtutil failed) — a native death can be neither ruled in nor ruled out'
          : `Windows event log not consulted on ${facts.platform} — a native death can be neither ruled in nor ruled out`,
    })
  } else {
    // 查过但没有原生死亡证据：列举仍开放的死因，不挑一个
    const clauses: string[] = []
    const opening =
      werEvents.length === 0
        ? 'no crash/hang/WER event for this exe in the Windows Application log, and no crash dump'
        : 'no crash/hang evidence for this exe in the Windows Application log (only non-fatal WER reports), and no crash dump'
    clauses.push(
      `${opening} — no native-death evidence, so the exit cannot be attributed: an external kill (task kill / antivirus), a machine shutdown or restart, and a crash WER never recorded are all possible`,
    )
    if (precursors.length > 0) {
      const names = [...new Set(precursors.map((event) => event.reportName ?? 'unknown'))].join(
        ', ',
      )
      clauses.push(
        `WER logged ${precursors.length} non-fatal report${precursors.length === 1 ? '' : 's'} (${names}) — a precursor, not a crash`,
      )
    }
    if (heavyRenderer) {
      clauses.push(describeHeavyProcess(heavyRenderer))
    } else if (heavyHosted) {
      clauses.push(describeHeavyProcess(heavyHosted))
    }
    lines.push({ level: 'warn', text: clauses.join('; ') })
  }

  const record = [
    `verdict=${verdict}`,
    `platform=${facts.platform}`,
    `wer=${facts.werEvents === undefined ? 'unavailable' : describeWerSummary(werEvents.map((event) => event.kind))}`,
    `dumps=${facts.crashDumpCount}`,
    `scene=${describeSceneSummary(facts.scene)}`,
  ].join('; ')

  return { verdict, lines, record }
}
