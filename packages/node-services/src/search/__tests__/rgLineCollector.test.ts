/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Deterministic tests for the rg stdout line collector — no real ripgrep involved,
 *  so the paths chunk boundaries never produce in practice (an unterminated final
 *  line) can be exercised exactly.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { RgLineCollector } from '../rgLineCollector.js'

describe('RgLineCollector', () => {
  it('joins chunks that split a line in half', () => {
    const collector = new RgLineCollector(10)
    collector.push('a.ts\nb')
    collector.push('.ts\n')
    collector.end('')
    expect(collector.lines).toEqual(['a.ts', 'b.ts'])
    expect(collector.scanned).toBe(2)
    expect(collector.capped).toBe(false)
  })

  it('treats an unterminated final line as a complete line', () => {
    const collector = new RgLineCollector(10)
    collector.push('a.ts\nlast.ts')
    collector.end('')
    expect(collector.lines).toEqual(['a.ts', 'last.ts'])
    expect(collector.scanned).toBe(2)
  })

  it('decodes-ahead tail bytes are absorbed before the final line', () => {
    // decoder.end() 的残余字节必须先并入 remainder，否则末行会被截断成两份。
    const collector = new RgLineCollector(10)
    collector.push('a.ts\nb')
    collector.end('ts')
    expect(collector.lines).toEqual(['a.ts', 'bts'])
  })

  it('filters complete lines through accept after normalizing separators', () => {
    const accept = vi.fn((relPath: string) => relPath.endsWith('.json'))
    const collector = new RgLineCollector(10, accept)
    collector.push('src\\a.json\nsrc\\b.ts\nlast.json')
    collector.end('')
    expect(collector.lines).toEqual(['src\\a.json', 'last.json'])
    // accept 在 normalizeRel 之后收到正斜杠相对路径，含无换行末行。
    expect(accept.mock.calls.map(([relPath]) => relPath)).toEqual([
      'src/a.json',
      'src/b.ts',
      'last.json',
    ])
  })

  it('counts the cap against accepted lines, not scanned ones', () => {
    const collector = new RgLineCollector(1, (relPath) => relPath === 'keep.json')
    collector.push('a.ts\nkeep.json\n')
    expect(collector.lines).toEqual(['keep.json'])
    expect(collector.scanned).toBe(2)
    expect(collector.capped).toBe(true)
    // capped 之后的分块与末行一律丢弃。
    collector.push('more.json\n')
    collector.end('tail.json')
    expect(collector.lines).toEqual(['keep.json'])
    expect(collector.scanned).toBe(2)
  })

  it('short-circuits a zero or negative cap: nothing is accepted or even examined', () => {
    const accept = vi.fn(() => true)
    for (const cap of [0, -1]) {
      const collector = new RgLineCollector(cap, accept)
      expect(collector.capped).toBe(true)
      collector.push('a.ts\nb.ts')
      collector.end('tail.ts')
      expect(collector.lines).toEqual([])
      expect(collector.scanned).toBe(0)
    }
    // 「不要任何结果」不该让 rg 的白名单回调跑任何一条路径。
    expect(accept).not.toHaveBeenCalled()
  })

  it('honours the cap for the unterminated final line too', () => {
    const collector = new RgLineCollector(1)
    collector.push('a.ts\nb.ts')
    collector.end('')
    expect(collector.lines).toEqual(['a.ts'])
    expect(collector.capped).toBe(true)
  })

  it('drops blank lines without counting them as scanned', () => {
    const collector = new RgLineCollector(10)
    collector.push('\n\na.ts\n')
    collector.end('')
    expect(collector.lines).toEqual(['a.ts'])
    expect(collector.scanned).toBe(1)
  })

  it('keeps three matches out of a 100k-line flood without hitting the cap', () => {
    // 合成数据代替真实巨型工作区：10 万条非匹配路径流过一次 push，命中 3 条。
    // 返回条目（= 跨 IPC 的载荷）不随扫描量增长，cap 也不该被非匹配条目吃掉。
    const FLOOD = 100_000
    const matches = new Set([12_345, 67_890, 99_999])
    const batch: string[] = []
    for (let i = 0; i < FLOOD; i++) {
      batch.push(matches.has(i) ? `gen/d${i}/tsconfig.json` : `gen/d${i % 100}/f${i}.ts`)
    }
    const collector = new RgLineCollector(10_000, (relPath) => relPath.endsWith('.json'))
    collector.push(`${batch.join('\n')}\n`)
    collector.end('')

    expect(collector.lines).toEqual([
      'gen/d12345/tsconfig.json',
      'gen/d67890/tsconfig.json',
      'gen/d99999/tsconfig.json',
    ])
    // 记账分开：扫描 10 万行，接受 3 行，cap 未被触发（它是按接受数计的）。
    expect(collector.scanned).toBe(FLOOD)
    expect(collector.capped).toBe(false)
    // 返回载荷（下游要过 IPC 的字节）与扫描量脱钩：负向过滤在流里完成，
    // 命中的 3 条之外的内容一条都不会进 lines。
    const scannedBytes = Buffer.byteLength(batch.join('\n'), 'utf8')
    const returnedBytes = Buffer.byteLength(collector.lines.join('\n'), 'utf8')
    expect(returnedBytes).toBeLessThan(scannedBytes / 1000)
  })
})
