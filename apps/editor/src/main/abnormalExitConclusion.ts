/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The single place that decides *why* the previous session is gone.
 *
 *  Two witnesses feed it: the Windows event log (crash/hang records vs. warnings)
 *  and our own metrics tail (what was climbing just before the log stopped). The
 *  verdict only escalates to "native death" on an actual crash/hang record —
 *  a memory-growth warning is a precursor, and reporting it as evidence would
 *  suppress the far more informative "no crash event at all, so it was killed
 *  from outside" verdict. An unreadable event log yields "indeterminate", never
 *  "external": unknown is not the same as absent.
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

export type AbnormalExitVerdict = 'native-death' | 'external-termination' | 'indeterminate'

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
 * Whether the process was *still* over its line is a fact about the last sample,
 * not about the fact that it was flagged at some point. On 2026-09-12 the flagged
 * renderer had fallen from 2747MB back to 687MB four minutes before the log
 * stopped; reading "still over its line" off `flaggedSamples` alone would have
 * pointed the whole post-mortem at an OOM kill the data does not support.
 */
function describeHeavyProcess(process: SceneProcess): string {
  const subject =
    process.type === 'Tab'
      ? `renderer pid ${process.pid}${process.window === undefined ? '' : ` (window-${process.window})`}`
      : `${process.name ?? 'a spawned process'}#${process.pid}`
  const line = `${process.thresholdMB ?? '?'}MB line`
  if (process.thresholdMB !== undefined && process.lastMB > process.thresholdMB) {
    return `our own log shows ${subject} peaked at ${process.peakMB}MB and was still over its ${line} in the last sample — consistent with a process killed while already past its memory line`
  }
  return `our own log shows ${subject} peaked at ${process.peakMB}MB while over its ${line}, but the final sample read ${process.lastMB}MB — it had come back under the line, so the peak does not explain the kill`
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
    facts.crashDumpCount > 0 || evidence.length > 0
      ? 'native-death'
      : facts.werEvents === undefined
        ? 'indeterminate'
        : 'external-termination'

  if (verdict === 'native-death') {
    const kinds = describeWerSummary(evidence.map((event) => event.kind))
    lines.push({
      level: 'error',
      text:
        facts.crashDumpCount > 0
          ? `crash dump found for the previous session — the process died natively`
          : `native crash/hang recorded for this exe in the Windows Application log (${kinds}) — the session died inside this process, not from an external kill`,
    })
  } else if (verdict === 'external-termination') {
    const clauses: string[] = []
    const opening =
      werEvents.length === 0
        ? 'no crash/hang/WER event for this exe in the Windows Application log'
        : 'no crash/hang evidence for this exe in the Windows Application log (only non-fatal WER reports)'
    clauses.push(
      `${opening} — process was likely terminated externally (task kill / AV) or the machine lost power`,
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
  } else {
    lines.push({
      level: 'warn',
      text:
        facts.platform === 'win32'
          ? 'Windows Application log could not be read (wevtutil failed) — a native death can be neither ruled in nor ruled out'
          : `Windows event log not consulted on ${facts.platform} — a native death can be neither ruled in nor ruled out`,
    })
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
