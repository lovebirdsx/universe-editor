/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/diagnostics/diagnosticsReport.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  aggregateErrorFingerprints,
  buildIssueMarkdown,
  type DiagnosticsSystemInfo,
} from '../diagnosticsReport.js'

const INFO: DiagnosticsSystemInfo = {
  appVersion: '1.2.3',
  electron: '33.0.0',
  chromium: '130.0.0',
  node: '20.18.0',
  os: 'Windows 10.0.19045 (x64)',
  cpus: 'Test CPU (8 × 3.0GHz)',
  memory: '16.0GB (free 8.0GB)',
  mode: 'release',
  locale: 'zh-CN',
}

function jsonl(...records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

describe('aggregateErrorFingerprints', () => {
  it('folds same-fingerprint records and sums counts, newest message wins', () => {
    const content = jsonl(
      {
        ts: 100,
        event: 'unhandledError',
        fingerprint: 'run@a.ts',
        source: 'main',
        count: 2,
        message: 'old',
      },
      {
        ts: 200,
        event: 'unhandledError',
        fingerprint: 'run@a.ts',
        source: 'main',
        count: 3,
        message: 'new',
      },
      {
        ts: 150,
        event: 'acp.prompt_failed',
        fingerprint: 'send@b.ts',
        source: 'renderer:1',
        count: 1,
        message: 'x',
      },
    )
    const top = aggregateErrorFingerprints(content)
    expect(top).toHaveLength(2)
    expect(top[0]).toMatchObject({ fingerprint: 'run@a.ts', count: 5, lastMessage: 'new' })
    expect(top[1]).toMatchObject({ fingerprint: 'send@b.ts', count: 1 })
  })

  it('keeps different sources of the same fingerprint separate', () => {
    const content = jsonl(
      { ts: 1, event: 'e', fingerprint: 'f@x.ts', source: 'main', count: 1, message: 'm' },
      { ts: 2, event: 'e', fingerprint: 'f@x.ts', source: 'renderer:1', count: 1, message: 'm' },
    )
    expect(aggregateErrorFingerprints(content)).toHaveLength(2)
  })

  it('skips malformed lines (crash-truncated tail) without failing', () => {
    const content =
      jsonl({ ts: 1, event: 'e', fingerprint: 'f@x.ts', source: 'main', count: 1, message: 'm' }) +
      '{"ts":2,"event":"e","fing'
    expect(aggregateErrorFingerprints(content)).toHaveLength(1)
  })

  it('caps the result at topN', () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      ts: i,
      event: 'e',
      fingerprint: `f${i}@x.ts`,
      source: 'main',
      count: 1,
      message: 'm',
    }))
    expect(aggregateErrorFingerprints(jsonl(...records), 10)).toHaveLength(10)
  })
})

describe('buildIssueMarkdown', () => {
  it('includes versions, system info and folded sections', () => {
    const md = buildIssueMarkdown(
      INFO,
      [{ id: 'pub.ext', version: '0.1.0', source: 'gallery' }],
      [
        {
          fingerprint: 'run@a.ts',
          event: 'unhandledError',
          source: 'main',
          count: 7,
          lastTs: 1,
          lastMessage: 'boom',
        },
      ],
    )
    expect(md).toContain('App version: 1.2.3 (release)')
    expect(md).toContain('Electron: 33.0.0')
    expect(md).toContain('| CPUs | Test CPU (8 × 3.0GHz) |')
    expect(md).toContain('<details><summary>Installed extensions (1)</summary>')
    expect(md).toContain('| pub.ext | 0.1.0 | gallery |')
    expect(md).toContain('| 7 | unhandledError | run@a.ts | main | boom |')
  })

  it('renders empty states when nothing is installed / recorded', () => {
    const md = buildIssueMarkdown(INFO, [], [])
    expect(md).toContain('(No extensions installed)')
    expect(md).toContain('(No recent errors)')
  })

  it('escapes pipes in table cells', () => {
    const md = buildIssueMarkdown(
      { ...INFO, cpus: 'a|b' },
      [],
      [
        {
          fingerprint: 'f|g',
          event: 'e',
          source: 'main',
          count: 1,
          lastTs: 1,
          lastMessage: 'x|y',
        },
      ],
    )
    expect(md).toContain('a\\|b')
    expect(md).toContain('f\\|g')
  })
})
