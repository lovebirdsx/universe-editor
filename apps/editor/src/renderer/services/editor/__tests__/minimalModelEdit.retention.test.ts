/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  minimalModelEdit.retention — 外部刷新读回来的那份文本必须能被回收。
 *
 *  形状与 e2e `smoke.docSyncExternalReload` 相同：往真文件追加、整读回来、把差异段交给模型侧
 *  持有者的**替代品**。区别是这里问真实 GC（而不是只看堆曲线的斜率），所以「读进来的那份文本
 *  是否留在堆里」可以直接断言，也不随机器快慢漂移。
 *
 *  被守的性质：交给模型的字符串不能是父串的切片视图。`String.prototype.slice` 返回的
 *  `SlicedString` 只记父串上的偏移，父串在视图活着时无法回收，而模型会原样持有这个字符串直到
 *  文档关闭——于是每轮刷新留下一整份盘上文本。判据因此取**逐轮增长**：首轮有一次性的常数
 *  （`getValue()` 的 rope 扁平化、V8 为十几 MB 分配留下的页），它不属于「每轮留一份」。
 *
 *  第一组守实现（差异段是副本 → 不留父串），第二组守**前提**（切片视图确实会钉住父串）。第二组
 *  若红了，说明 V8 的字符串表示变了、`detachView` 是否还必要需要重新评估——那是结论要变，不是抖动。
 *  事故证据与修前修后曲线见 `docs/development/memory-pressure.md`。
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import v8 from 'node:v8'
import { mkTempDir } from '@universe-editor/temp-root'
import { applyMinimalTextEdit, type IEditableTextModel } from '../minimalModelEdit.js'
import { splitLeadingBom } from '../leadingBom.js'

/** 体量与 e2e 那份合成日志同量级（8M 字符 ≈ 7.6MiB 盘上字节）。 */
const FILE_CHARS = 8 * 1024 * 1024
/** 每轮追加的字符数（约 4KB，同 e2e 的每批 flush）。 */
const APPEND_CHARS = 4 * 1024
const ROUNDS = 16

/** 逐轮增长的允许量：追加内容本身（16 × 4KB）+ 模型侧记账 + 机器抖动。修复前每轮留一份 8M
 *  字符的父串（逐轮 16MB 量级），8MB 这条线拦得住回归，又不会因为 GC 时机误报。 */
const RETAINED_GROWTH_BOUND_BYTES = 8 * 1024 * 1024
/** 切片视图每轮必须留下一份父串：15 轮 ≥ 64MB，留足机器差异。 */
const VIEW_GROWTH_MIN_BYTES = 64 * 1024 * 1024

/** 落在本轮测试专属的临时根下（`@universe-editor/temp-root`，整轮结束即整体删除）。 */
const dir = mkTempDir('ue-minimaledit-')

/** `--expose-gc` 不进本包的 vitest pool 配置，用官方逃生口：设标志、从一次性 vm 上下文取 `gc`。
 *  取不到必须 fail loud 而不是 skip——静默不再运行的回收断言比没有更糟。 */
function acquireGc(): () => void {
  const fromGlobal = (globalThis as { gc?: () => void }).gc
  if (typeof fromGlobal === 'function') return fromGlobal
  try {
    v8.setFlagsFromString('--expose-gc')
    const fromContext: unknown = vm.runInNewContext('gc')
    if (typeof fromContext === 'function') return fromContext as () => void
  } catch {
    // 落到下面那处唯一的显式失败
  }
  throw new Error('拿不到 GC：请带 --expose-gc 运行，或 v8.setFlagsFromString 逃生口必须继续可用')
}

/** 完整回收 + 一个任务边界，再读堆。WeakRef 的目标要活到读它的那个 job 结束。 */
async function liveHeapBytes(gc: () => void, passes = 2): Promise<number> {
  for (let i = 0; i < passes; i++) {
    gc()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return process.memoryUsage().heapUsed
}

/** 合成日志行；`seq` 让每一行都不同，尾部比对才做得出真实的最小编辑。 */
function logLine(seq: number): string {
  const stamp = `2026-09-19T00:00:${String(seq % 60).padStart(2, '0')}.000Z`
  return `${stamp} INFO  tick=${seq} entity=player.avatar state=flying payload=${'x'.repeat(120)}`
}

/** CRLF 占多数、每 50 行混一条裸 LF、开头带 BOM——模型 EOL 由多数行尾决定，恒为 CRLF。 */
function syntheticLog(targetChars: number): string {
  const parts: string[] = ['﻿']
  let chars = 1
  let seq = 0
  while (chars < targetChars) {
    const eol = seq % 50 === 49 ? '\n' : '\r\n'
    parts.push(logLine(seq), eol)
    chars += logLine(seq).length + eol.length
    seq++
  }
  return parts.join('')
}

function syntheticAppend(fromSeq: number, chars: number): string {
  let out = ''
  let seq = fromSeq
  while (out.length < chars) {
    out += logLine(seq) + (seq % 50 === 49 ? '\n' : '\r\n')
    seq++
  }
  return out
}

/** 模型侧持有者的**替代品**：Monaco 的 piece tree 真实现会把 `pushEditOperations` 收到的字符串
 *  原样放进 `StringBuffer`（不做扁平化），那个字符串对象活到文档关闭；这里照此形状持有。 */
class PieceTreeStandIn implements IEditableTextModel {
  readonly inserted: string[] = []
  private value: string
  constructor(initial: string) {
    this.value = initial
  }
  getEOL(): string {
    return '\r\n'
  }
  getValue(): string {
    return this.value
  }
  setValue(value: string): void {
    this.value = value
  }
  getPositionAt(offset: number): { lineNumber: number; column: number } {
    return { lineNumber: 1, column: offset + 1 }
  }
  pushEditOperations(
    _base: null,
    edits: ReadonlyArray<{
      range: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      }
      text: string
    }>,
  ): null {
    for (const edit of edits) {
      this.inserted.push(edit.text)
      this.value += edit.text
    }
    return null
  }
}

/** 造一份盘上日志，返回文件路径。每次调用一份新文件，两组用例互不共享可变状态。 */
function seedLog(name: string): string {
  const file = join(dir, name)
  writeFileSync(file, syntheticLog(FILE_CHARS))
  return file
}

/** 跑 `ROUNDS` 轮真写盘 + 整读盘，每轮把读回来的那份文本交给 `handOver`，回收后记一次堆。
 *  循环体只在函数内部持有 `diskText`，它随下一轮重新赋值而失去引用。 */
async function runRounds(
  gc: () => void,
  file: string,
  fromSeq: number,
  handOver: (diskText: string) => void,
): Promise<number[]> {
  const readings: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    appendFileSync(file, syntheticAppend(fromSeq + round, APPEND_CHARS))
    handOver(readFileSync(file, 'utf8'))
    readings.push(await liveHeapBytes(gc))
  }
  return readings
}

/** 逐轮增长：首轮的一次性常数不进判据（理由见文件头）。 */
const growthAcrossRounds = (readings: readonly number[]): number =>
  (readings[readings.length - 1] ?? 0) - (readings[0] ?? 0)

describe('minimalModelEdit — a reload leaves no copy of the file behind', () => {
  it('keeps only the span it inserted, not the text the span was cut from', async () => {
    const gc = acquireGc()
    const file = seedLog('subject.log')
    // 与 FileEditorInput 同口径：模型拿到的是去 BOM 的那一份。口径不一致会让每轮的差异段退化成
    // 整篇，用例随之失真（它读起来像「修复无效」）。
    const model = new PieceTreeStandIn(
      splitLeadingBom(readFileSync(file, 'utf8')).text.replace(/\r\n|\r|\n/g, '\r\n'),
    )
    const sentinel = new WeakRef({ probe: 'collectable' })

    const readings = await runRounds(gc, file, 1000, (diskText) => {
      // 真入口：读盘文本 →（去 BOM）→ EOL 归一化 → 最小编辑 → pushEditOperations。
      expect(applyMinimalTextEdit(model, splitLeadingBom(diskText).text)).toBe('edited')
    })
    // 最后一轮之后再回收一次，作为收尾读数。
    const finalReading = await liveHeapBytes(gc, 4)

    // 控制对象（只剩 WeakRef）必须被回收：它仍存活只说明这一轮没能证明不可达对象可回收，
    // 增长读数随之不可解释——报错，别当成泄漏，也别据此说 GC 没跑。
    expect(sentinel.deref()).toBeUndefined()

    // 形状先钉住：每轮交出去的必须是那一轮追加的那一段，不是整篇。
    expect(model.inserted).toHaveLength(ROUNDS)
    for (const span of model.inserted) {
      expect(span.length).toBeLessThanOrEqual(APPEND_CHARS + 64)
    }
    expect(model.inserted.reduce((sum, text) => sum + text.length, 0)).toBeGreaterThan(
      ROUNDS * APPEND_CHARS,
    )

    const growth = Math.max(growthAcrossRounds(readings), finalReading - (readings[0] ?? 0))
    expect(
      growth,
      `刷新读进来的文本被留在了堆里：${ROUNDS} 轮之后每轮多留 ${(growth / Math.max(1, ROUNDS - 1) / 1048576).toFixed(1)}MB`,
    ).toBeLessThan(RETAINED_GROWTH_BOUND_BYTES)
  })

  it('would retain one whole file per round if the span were a slice view (premise)', async () => {
    const gc = acquireGc()
    const file = seedLog('control.log')
    // 修复前的形状：差异段是切片视图（这里取尾部同样长的一段代表它）。
    const held: string[] = []

    const readings = await runRounds(gc, file, 2000, (diskText) => {
      held.push(diskText.slice(diskText.length - APPEND_CHARS))
    })

    expect(held).toHaveLength(ROUNDS)
    const growth = growthAcrossRounds(readings)
    expect(
      growth,
      `切片视图不再钉住父串（15 轮只多出 ${(growth / 1048576).toFixed(1)}MB）：V8 的字符串表示变了，` +
        `detachView 的取舍需要重新评估——这是前提变了，不是抖动`,
    ).toBeGreaterThan(VIEW_GROWTH_MIN_BYTES)
  })
})
