import { describe, expect, it } from 'vitest'
import {
  WarnThrottle,
  buildSlowInteractionReport,
  createTypeStats,
  dedupeByInteraction,
  decomposeInteraction,
  estimateQuantile,
  extractLoafScripts,
  formatLongFrameLine,
  formatSlowInteractionLine,
  formatSuppressedSuffix,
  isUnattributedLongFrame,
  recordDuration,
  type InteractionEventSample,
  type LoafSample,
} from '../interactionPerf.js'

const sample = (
  eventType: string,
  startTime: number,
  duration: number,
  interactionId: number,
  processing = { startOffset: 8, endOffset: 96 },
): InteractionEventSample => ({
  eventType,
  startTime,
  processingStart: startTime + processing.startOffset,
  processingEnd: startTime + processing.endOffset,
  duration,
  interactionId,
})

const loaf = (
  startTime: number,
  duration: number,
  blockingDuration: number,
  scripts: LoafSample['scripts'] = [],
): LoafSample => ({ startTime, duration, blockingDuration, scripts })

describe('decomposeInteraction', () => {
  it('splits into input / processing / presentation thirds', () => {
    const d = decomposeInteraction(sample('keydown', 100, 312, 1))
    expect(d.inputDelayMs).toBe(8)
    expect(d.processingMs).toBe(88)
    expect(d.presentationDelayMs).toBe(216)
  })

  it('clamps a negative presentation delay caused by 8ms duration rounding', () => {
    // measured span = 96ms but the rounded duration reports 88
    const d = decomposeInteraction({
      eventType: 'click',
      startTime: 100,
      processingStart: 108,
      processingEnd: 196,
      duration: 88,
      interactionId: 1,
    })
    expect(d.presentationDelayMs).toBe(0)
    expect(d.inputDelayMs + d.processingMs).toBe(96)
  })
})

describe('dedupeByInteraction', () => {
  it('keeps only the slowest entry per non-zero interactionId', () => {
    const result = dedupeByInteraction([
      sample('pointerdown', 100, 256, 7),
      sample('pointerup', 100, 256, 7),
      sample('click', 100, 312, 7),
      sample('keydown', 500, 24, 8),
    ])
    expect(result).toHaveLength(2)
    const clickInteraction = result.find((r) => r.sample.interactionId === 7)
    expect(clickInteraction?.sample.eventType).toBe('click')
    expect(clickInteraction?.sample.duration).toBe(312)
    expect(clickInteraction?.eventTypes).toEqual(['pointerdown', 'pointerup', 'click'])
  })

  it('routes interactionId 0 entries to the non-interaction channel', () => {
    const result = dedupeByInteraction([
      sample('pointerenter', 0, 16, 0),
      sample('keydown', 100, 32, 1),
    ])
    expect(result.filter((r) => r.kind === 'non-interaction')).toHaveLength(1)
    expect(result.filter((r) => r.kind === 'interaction')).toHaveLength(1)
  })
})

describe('histogram + estimateQuantile', () => {
  it('counts per bucket, tracks max, and estimates quantiles by bucket lower bound', () => {
    const stats = createTypeStats()
    // 20 samples: 10 in [0,16], 5 in (16,25], 3 in (25,50], 1 in (50,100], 1 in (1000,∞)
    for (let i = 0; i < 10; i++) recordDuration(stats, 16)
    for (let i = 0; i < 5; i++) recordDuration(stats, 24)
    for (let i = 0; i < 3; i++) recordDuration(stats, 40)
    recordDuration(stats, 88)
    recordDuration(stats, 1200)
    expect(stats.count).toBe(20)
    expect(stats.maxMs).toBe(1200)
    expect(stats.buckets).toEqual([10, 5, 3, 1, 0, 0, 0, 1])
    // p50 → 10th sample lands in bucket 0 → lower bound 0
    expect(estimateQuantile(stats, 0.5)).toBe(0)
    // p75 → 15th sample lands in bucket (16,25] → 16
    expect(estimateQuantile(stats, 0.75)).toBe(16)
    // p95 → 19th sample lands in bucket (50,100] → 50
    expect(estimateQuantile(stats, 0.95)).toBe(50)
    // p100 → last sample in overflow bucket → 1000
    expect(estimateQuantile(stats, 1)).toBe(1000)
  })

  it('answers 0 for an empty histogram', () => {
    expect(estimateQuantile(createTypeStats(), 0.95)).toBe(0)
  })
})

describe('extractLoafScripts', () => {
  it('keeps the top-3 by duration and truncates long urls from the tail', () => {
    const scripts = extractLoafScripts([
      { invoker: 'a', sourceURL: 'u1', sourceFunctionName: 'f1', duration: 10 },
      { invoker: 'b', sourceURL: 'u2', sourceFunctionName: 'f2', duration: 90 },
      { invoker: 'c', sourceURL: 'u3', sourceFunctionName: 'f3', duration: 50 },
      { invoker: 'd', sourceURL: 'u4', sourceFunctionName: 'f4', duration: 30 },
    ])
    expect(scripts.map((s) => s.invoker)).toEqual(['b', 'c', 'd'])
  })

  it('truncates the source url keeping the tail (file name survives)', () => {
    const url = `https://example.com/${'x'.repeat(100)}/index-abc123.js`
    const [s] = extractLoafScripts([{ invoker: 'i', sourceURL: url, duration: 1 }])
    expect(s?.sourceUrl.length).toBe(80)
    expect(s?.sourceUrl.endsWith('index-abc123.js')).toBe(true)
  })

  it('tolerates missing fields', () => {
    const [s] = extractLoafScripts([{}])
    expect(s).toEqual({ invoker: '', sourceUrl: '', sourceFunctionName: '', durationMs: 0 })
  })
})

describe('buildSlowInteractionReport + formatSlowInteractionLine', () => {
  it('intersects phases and loafs with the interaction window and formats one line', () => {
    const report = buildSlowInteractionReport({
      sample: sample('keydown', 1000, 312, 42),
      kind: 'interaction',
      eventTypes: ['keydown', 'keypress', 'keyup'],
      phases: [
        { name: 'fileEditor.setModel', startTime: 1010, duration: 96 },
        { name: 'before.window', startTime: 100, duration: 10 },
      ],
      loafs: [
        loaf(1050, 280, 200, [
          {
            invoker: 'TimerHandler:setTimeout',
            sourceUrl: 'out/renderer/assets/index-abc.js',
            sourceFunctionName: 'performWork',
            durationMs: 260,
          },
        ]),
        loaf(5000, 300, 250, []),
      ],
      context: { target: 'div#root', editor: 'file:///big.ts (typescript, 4321 lines)' },
    })
    expect(report.phases.map((p) => p.name)).toEqual(['fileEditor.setModel'])
    expect(report.loafs).toHaveLength(1)

    const line = formatSlowInteractionLine(report)
    expect(line).toContain('slow keydown 312ms')
    expect(line).toContain('(input 8 / processing 88 / present 216)')
    expect(line).toContain('events=[keydown+keypress+keyup]')
    expect(line).toContain('target=div#root')
    expect(line).toContain('editor=file:///big.ts (typescript, 4321 lines)')
    expect(line).toContain('phases: [fileEditor.setModel 96ms @+10ms]')
    expect(line).toContain('loaf: [frame 280ms blocking 200ms:')
    expect(line).toContain('index-abc.js#performWork (TimerHandler:setTimeout) 260ms')
  })

  it('marks non-interaction reports and omits empty sections', () => {
    const report = buildSlowInteractionReport({
      sample: sample('pointerenter', 100, 208, 0),
      kind: 'non-interaction',
      eventTypes: ['pointerenter'],
      phases: [],
      loafs: [],
      context: { target: 'body', editor: '' },
    })
    const line = formatSlowInteractionLine(report)
    expect(line).toContain('slow (non-interaction) pointerenter 208ms')
    expect(line).not.toContain('events=')
    expect(line).not.toContain('phases:')
    expect(line).not.toContain('loaf:')
    expect(line).not.toContain('editor=')
  })
})

describe('isUnattributedLongFrame + formatLongFrameLine', () => {
  it('flags frames past the blocking threshold that overlap no interaction', () => {
    const interactions = [{ startTime: 1000, duration: 300 }]
    expect(isUnattributedLongFrame(loaf(1050, 400, 250), interactions, 200)).toBe(false)
    expect(isUnattributedLongFrame(loaf(5000, 400, 250), interactions, 200)).toBe(true)
    expect(isUnattributedLongFrame(loaf(5000, 400, 100), interactions, 200)).toBe(false)
  })

  it('formats the standalone long-frame line', () => {
    const line = formatLongFrameLine(
      loaf(5000, 480, 400, [
        {
          invoker: 'MessagePort.onmessage',
          sourceUrl: 'worker.js',
          sourceFunctionName: '',
          durationMs: 470,
        },
      ]),
    )
    expect(line).toContain('long frame 480ms blocking 400ms (no interaction)')
    expect(line).toContain('worker.js (MessagePort.onmessage) 470ms')
  })
})

describe('WarnThrottle', () => {
  it('allows the first warn per key, suppresses within the window, then folds the count', () => {
    let now = 1000
    const throttle = new WarnThrottle(1000, () => now)
    expect(throttle.tryWarn('interaction:keydown')).toBe(0)
    now += 100
    expect(throttle.tryWarn('interaction:keydown')).toBeUndefined()
    now += 100
    expect(throttle.tryWarn('interaction:keydown')).toBeUndefined()
    // different key is independent
    expect(throttle.tryWarn('interaction:click')).toBe(0)
    // window expiry folds the suppressed count into the next allowed warn
    now += 900
    expect(throttle.tryWarn('interaction:keydown')).toBe(2)
    expect(formatSuppressedSuffix(2, 'keydown')).toBe(' (suppressed 2 more slow keydown)')
    expect(formatSuppressedSuffix(0, 'keydown')).toBe('')
  })
})
