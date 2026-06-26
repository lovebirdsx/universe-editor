/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StartupPerformanceEditor — VSCode-style startup perf view. Reads the merged
 *  main + renderer timeline from ITimerService and renders it as tables.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { IEditorInput, localize } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { ITimerService, type IStartupMetrics } from '../../services/performance/TimerService.js'
import styles from './StartupPerformanceEditor.module.css'

function fmt(ms: number): string {
  return `${ms.toFixed(1)} ms`
}

export function StartupPerformanceEditor(_props: { input: IEditorInput }) {
  const timerService = useService(ITimerService)
  const [metrics, setMetrics] = useState<IStartupMetrics | null>(null)

  useEffect(() => {
    let cancelled = false
    void timerService.getStartupMetrics().then((m) => {
      if (!cancelled) setMetrics(m)
    })
    return () => {
      cancelled = true
    }
  }, [timerService])

  if (!metrics) {
    return (
      <div className={styles['root']} data-testid="startup-performance">
        <div className={styles['measuring']}>
          {localize('startupPerformance.measuring', 'Measuring startup performance…')}
        </div>
      </div>
    )
  }

  const origin = metrics.marks[0]?.startTime ?? 0

  return (
    <div className={styles['root']} data-testid="startup-performance">
      <h1 className={styles['title']}>
        {localize('startupPerformance.title', 'Startup Performance')}
      </h1>
      <div className={styles['summary']}>
        {localize('startupPerformance.total', 'Total startup time:')}{' '}
        <strong>{(metrics.totalTime / 1000).toFixed(2)} s</strong>
      </div>

      <h2 className={styles['heading']}>{localize('startupPerformance.phases', 'Phases')}</h2>
      <table className={styles['table']}>
        <thead>
          <tr>
            <th>{localize('startupPerformance.from', 'From')}</th>
            <th>{localize('startupPerformance.to', 'To')}</th>
            <th className={styles['num']}>{localize('startupPerformance.duration', 'Duration')}</th>
          </tr>
        </thead>
        <tbody>
          {metrics.phases.map((p, i) => (
            <tr key={i}>
              <td>{p.from}</td>
              <td>{p.to}</td>
              <td className={styles['num']}>{fmt(p.duration)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className={styles['heading']}>{localize('startupPerformance.marks', 'Marks')}</h2>
      <table className={styles['table']}>
        <thead>
          <tr>
            <th>{localize('common.name', 'Name')}</th>
            <th className={styles['num']}>
              {localize('startupPerformance.offset', 'Offset from start')}
            </th>
          </tr>
        </thead>
        <tbody>
          {metrics.marks.map((m, i) => (
            <tr key={i}>
              <td className={styles['mono']}>{m.name}</td>
              <td className={styles['num']}>{fmt(m.startTime - origin)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
