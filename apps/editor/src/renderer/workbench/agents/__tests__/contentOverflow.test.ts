/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  contentOverflow 单测 — 守护「首帧即最终夹高」的两个地基：
 *   1. CJK 宽度感知的溢出估算：中文在等宽/比例字体下都按约两倍列宽渲染，按
 *      字符数估行数会低估一半 → 「估算不溢出、实测溢出」→ 每次挂载先全高再
 *      异步夹矮 → 虚拟列表 size-change 补偿环（outline 跳转后向上滚动时列表
 *      上下闪动、持续漂移的根因）。
 *   2. contentKey 测量缓存：估算永远有边缘偏差（图片、字体、容器宽度），
 *      remount 以上次实测为准，把「翻转」限制在首次测量那一次。
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetMeasuredOverflowForTests,
  estimateTerminalOverflow,
  estimateUserMessageOverflow,
  estimateWrappedLinesUpTo,
  initialOverflow,
  recallMeasuredOverflow,
  rememberMeasuredOverflow,
} from '../contentOverflow.js'

describe('estimateWrappedLinesUpTo', () => {
  it('counts plain ascii lines with wrap', () => {
    expect(estimateWrappedLinesUpTo('a\nb\nc', 80, 100)).toBe(3)
    expect(estimateWrappedLinesUpTo('x'.repeat(200), 80, 100)).toBe(3)
    expect(estimateWrappedLinesUpTo('', 80, 100)).toBe(1)
  })

  it('stops early at maxLines for huge single-line blobs', () => {
    const blob = 'A'.repeat(1_000_000)
    expect(estimateWrappedLinesUpTo(blob, 80, 16)).toBeGreaterThanOrEqual(16)
  })

  it('counts CJK characters as two columns wide', () => {
    // 100 个汉字 ≈ 200 列 → 80 列 wrap 下 3 行；按字符数只会算 2 行。
    expect(estimateWrappedLinesUpTo('测'.repeat(100), 80, 100)).toBe(3)
  })
})

describe('estimateTerminalOverflow', () => {
  it('keeps short output unclamped', () => {
    expect(estimateTerminalOverflow('one line')).toBe(false)
  })

  it('clamps long ascii output', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(estimateTerminalOverflow(text)).toBe(true)
  })

  it('clamps a long single-line CJK output (wraps at half the columns)', () => {
    // 600 个汉字 ≈ 1200 列 ≈ 15 行 × 16px + padding > 240px 的折叠阈值。
    // 按 seg.length/80 只估出 8 行 → 误判不溢出 → 首帧全高、异步夹矮 → 补偿环。
    expect(estimateTerminalOverflow('码'.repeat(600))).toBe(true)
  })

  it('clamps multi-line CJK output like its rendered height', () => {
    // 14 行 × 60 个汉字（≈120 列 → 每行 wrap 成 2 行）≈ 28 渲染行，远超 15 行阈值；
    // 按字符数只估出 14 行（232px ≤ 240px）会误判不溢出。
    const text = Array.from({ length: 14 }, () => '中文输出内容'.repeat(10)).join('\n')
    expect(estimateTerminalOverflow(text)).toBe(true)
  })
})

describe('estimateUserMessageOverflow', () => {
  it('keeps a short prompt unclamped', () => {
    expect(estimateUserMessageOverflow([{ type: 'text', text: '你好' }])).toBe(false)
  })

  it('clamps a many-line prompt', () => {
    const text = Array.from({ length: 12 }, (_, i) => `第${i}行：审查说明`).join('\n')
    expect(estimateUserMessageOverflow([{ type: 'text', text }])).toBe(true)
  })

  it('clamps a long single-line CJK prompt (wraps at half the columns)', () => {
    // 380 个汉字 ≈ 760 列 ≈ 9 行 × 21px > 160px；按字符数只估出 5 行会误判。
    expect(estimateUserMessageOverflow([{ type: 'text', text: '审'.repeat(380) }])).toBe(true)
  })

  it('treats image blocks as overflowing (height unknowable before decode)', () => {
    expect(
      estimateUserMessageOverflow([
        { type: 'text', text: 'см' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ]),
    ).toBe(true)
  })
})

describe('measured-overflow cache', () => {
  beforeEach(() => _resetMeasuredOverflowForTests())

  it('seeds a remount from the measured truth instead of the estimate', () => {
    expect(initialOverflow('k1', () => false)).toBe(false)
    rememberMeasuredOverflow('k1', true)
    expect(recallMeasuredOverflow('k1')).toBe(true)
    expect(initialOverflow('k1', () => false)).toBe(true)
  })

  it('lets a grown-content estimate override a stale false measurement', () => {
    rememberMeasuredOverflow('k1', false)
    expect(initialOverflow('k1', () => true)).toBe(true)
  })

  it('ignores undefined keys', () => {
    rememberMeasuredOverflow(undefined, true)
    expect(recallMeasuredOverflow(undefined)).toBeUndefined()
    expect(initialOverflow(undefined, () => true)).toBe(true)
  })
})
