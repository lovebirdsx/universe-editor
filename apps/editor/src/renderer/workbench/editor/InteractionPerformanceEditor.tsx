/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  InteractionPerformanceEditor — session snapshot of the responsiveness floor:
 *  overview, per-type histograms, and the slowest interactions with their
 *  decomposition + attribution. Pulls IInteractionPerfService.getSummary() on
 *  mount and on manual refresh; read-only.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import { IEditorInput, localize } from '@universe-editor/platform'
import { useService } from '../useService.js'
import {
  IInteractionPerfService,
  type InteractionPerfSummary,
} from '../../services/performance/InteractionPerfService.js'
import styles from './InteractionPerformanceEditor.module.css'

function fmt(ms: number): string {
  return `${Math.round(ms)} ms`
}

export function InteractionPerformanceEditor(_props: { input: IEditorInput }) {
  const interactionPerf = useService(IInteractionPerfService)
  const [summary, setSummary] = useState<InteractionPerfSummary | null>(null)

  const refresh = useCallback(() => {
    setSummary(interactionPerf.getSummary())
  }, [interactionPerf])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!summary) {
    return <div className={styles['root']} data-testid="interaction-performance" />
  }

  const slowShare =
    summary.interactionCount > 0
      ? `${((summary.slowCount / summary.interactionCount) * 100).toFixed(1)}%`
      : '—'
  const types = Object.entries(summary.byType).sort((a, b) => b[1].count - a[1].count)

  return (
    <div className={styles['root']} data-testid="interaction-performance">
      <h1 className={styles['title']}>
        {localize('interactionPerformance.title', 'Interaction Performance')}
        <button className={styles['refresh']} onClick={refresh}>
          {localize('interactionPerformance.refresh', 'Refresh')}
        </button>
      </h1>
      <div className={styles['summary']}>
        {localize(
          'interactionPerformance.overview',
          'Interactions sampled: {count} · Slow: {slow} ({share}) · Long frames: {loaf}',
          {
            count: summary.interactionCount,
            slow: summary.slowCount,
            share: slowShare,
            loaf: summary.loafCount,
          },
        )}
      </div>
      <div className={styles['note']}>
        {localize(
          'interactionPerformance.samplingNote',
          'Only interactions taking ≥16 ms are sampled (Event Timing duration threshold); quantiles are histogram bucket lower bounds over those samples.',
        )}
      </div>

      <h2 className={styles['heading']}>
        {localize('interactionPerformance.byType', 'By interaction type')}
      </h2>
      {types.length === 0 ? (
        <div className={styles['empty']}>
          {localize('interactionPerformance.noSamples', 'No interactions sampled yet.')}
        </div>
      ) : (
        <table className={styles['table']}>
          <thead>
            <tr>
              <th>{localize('interactionPerformance.type', 'Type')}</th>
              <th className={styles['num']}>{localize('interactionPerformance.count', 'Count')}</th>
              <th className={styles['num']}>{localize('interactionPerformance.p95', 'p95')}</th>
              <th className={styles['num']}>{localize('interactionPerformance.p99', 'p99')}</th>
              <th className={styles['num']}>{localize('interactionPerformance.max', 'Max')}</th>
            </tr>
          </thead>
          <tbody>
            {types.map(([type, stats]) => (
              <tr key={type}>
                <td className={styles['mono']}>{type}</td>
                <td className={styles['num']}>{stats.count}</td>
                <td className={styles['num']}>{fmt(stats.p95Ms)}</td>
                <td className={styles['num']}>{fmt(stats.p99Ms)}</td>
                <td className={styles['num']}>{fmt(stats.maxMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className={styles['heading']}>
        {localize('interactionPerformance.slowest', 'Slowest interactions')}
      </h2>
      {summary.slowest.length === 0 ? (
        <div className={styles['empty']}>
          {localize('interactionPerformance.noSlow', 'No slow interactions recorded.')}
        </div>
      ) : (
        <table className={styles['table']}>
          <thead>
            <tr>
              <th>{localize('interactionPerformance.type', 'Type')}</th>
              <th className={styles['num']}>
                {localize('interactionPerformance.duration', 'Duration')}
              </th>
              <th className={styles['num']}>
                {localize('interactionPerformance.split', 'Input / Processing / Present')}
              </th>
              <th>{localize('interactionPerformance.attribution', 'Attribution')}</th>
              <th>{localize('interactionPerformance.context', 'Context')}</th>
            </tr>
          </thead>
          <tbody>
            {summary.slowest.map((entry, i) => {
              const { report } = entry
              const d = report.decomposition
              const attribution = [
                ...report.phases.map((p) => `${p.name} ${Math.round(p.duration)}ms`),
                ...report.loafs.flatMap((l) =>
                  l.scripts.map(
                    (s) =>
                      `${s.sourceUrl || '<anonymous>'}${s.sourceFunctionName ? `#${s.sourceFunctionName}` : ''} ${Math.round(s.durationMs)}ms`,
                  ),
                ),
              ].join(' · ')
              const context = [report.context.target, report.context.editor]
                .filter(Boolean)
                .join(' · ')
              return (
                <tr key={i}>
                  <td className={styles['mono']}>{entry.label}</td>
                  <td className={styles['num']}>{fmt(entry.durationMs)}</td>
                  <td className={styles['num']}>
                    {`${Math.round(d.inputDelayMs)} / ${Math.round(d.processingMs)} / ${Math.round(d.presentationDelayMs)}`}
                  </td>
                  <td className={styles['mono']}>{attribution || '—'}</td>
                  <td className={styles['mono']}>{context || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
