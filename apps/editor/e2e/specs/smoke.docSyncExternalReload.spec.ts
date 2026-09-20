/*---------------------------------------------------------------------------------------------
 *  外部改写的 10MB 日志：读盘有界、出站是增量（@regression）
 *
 *  守护 2026-09-19 的渲染进程 OOM。现场是一个游戏客户端在追加的 10.2M 日志：盘上行尾混写，而
 *  Monaco 的缓冲区只有一种行尾，于是每次 watcher 批次都「读一遍盘 → 判定与磁盘不同 → 推一份
 *  近全文的 didChange」（`docSync.log` 里 43 次 ≥1M chars、合计 481M chars）。
 *  原事故没有 heap snapshot；机制与修前修后曲线见 `docs/development/memory-pressure.md`。
 *
 *  本 spec 用真窗口 + 真 node fs 写入复现那个场景，断言**形状**而不是墙钟或 MB：
 *   1. 同内容原子重写：一次读盘（`extreload`），**零**出站编辑——盘上字节没变就不该有 didChange；
 *   2. 24 轮各约 4KB 追加（4 轮一批）：每批至少一次读盘，出站量与追加量同阶，绝不是 N 份文档；
 *   3. 全程 `docSync` 载荷（积压 + 在途，窗口内采样取峰值）有界；模型与磁盘一致（两侧各算一次
 *      指纹，正文不过桥）；缓冲区不脏；
 *   4. 堆：强制回收后断言 `growth / (2 × extreload.chars)` < 0.5，即「每读一次盘不许把这一份
 *      文本留在堆里」。修复前实测该比值稳定在 1.01（每轮留下一整份盘上文本），修后 0.0x。
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electronApp.js'

const BOM = '﻿'
/** 体量与 2026-09-19 事故里的 10.2M 文档同量级。 */
const LOG_TARGET_CHARS = 10 * 1024 * 1024
/** 每轮追加的字符数（约 4KB，像日志进程每次 flush 一段）。 */
const APPEND_CHARS = 4 * 1024
const ROUNDS = 24
const ROUNDS_PER_BATCH = 4
const BATCHES = ROUNDS / ROUNDS_PER_BATCH
/** 每轮的等待上限：一批 watcher 事件 + 一次 10MB 读盘 + 一次最小编辑扫描。 */
const ROUND_TIMEOUT_MS = 30_000
/** 初始镜像的等待上限：10MB 建模型 + 扩展宿主冷启 + 整篇 open。 */
const OPEN_TIMEOUT_MS = 90_000
/**
 * 一次出站相对一次追加的余量。最小编辑会按公共前后缀裁剪，所以正常读数略小于追加量；
 * 余量留给块边界上被多带进来的一两行，以及裸 LF 归一化多出来的那个字符。
 */
const PUSH_SLACK_CHARS = 256
/** 载荷（积压 + 在途）的上界。管道自己的上限是 2Mi chars；这里量的是「没有人在攒」。 */
const PAYLOAD_BOUND_CHARS = 256 * 1024
/**
 * 堆增长的上界，按**这一趟读盘读进来的字节数**计（`2 × extreload.chars`），不是按文件大小：
 * 这条线守的是读侧——每读一次盘不许把这一份文本留在堆里。
 *
 * 线取 0.5 留了余量：Monaco 追加内容本身、undo 记录、镜像记账都有与追加量同阶的合法增长，机器
 * 抖动也在这一档里；而它离修复前的 1.01 仍有 2 倍差距，任何「一次读盘留下一份文本」的回归都会
 * 撞线（实测读数由用例打印为 `growthPerReloadBytes`）。
 */
const HEAP_GROWTH_BOUND_RELOAD_FACTOR = 0.5

/** 合成日志行；`seq` 让每一行都不同，尾部比对才做得出真实的最小编辑。 */
function logLine(seq: number): string {
  const stamp = `2026-09-19T00:00:${String(seq % 60).padStart(2, '0')}.000Z`
  return `${stamp} INFO  tick=${seq} entity=player.avatar state=flying payload=${'x'.repeat(120)}`
}

/** CRLF 占多数（模型 EOL 由多数行尾决定）、每 50 行混一行裸 LF、开头带 BOM。 */
function syntheticLog(targetChars: number): string {
  const parts: string[] = [BOM]
  let chars = BOM.length
  let seq = 0
  while (chars < targetChars) {
    const eol = seq % 50 === 49 ? '\n' : '\r\n'
    parts.push(logLine(seq), eol)
    chars += logLine(seq).length + eol.length
    seq++
  }
  return parts.join('')
}

/** 一段追加内容：从行首开始，不会与上一行末尾的 CR 拼出一个跨块行尾。 */
function syntheticAppend(fromSeq: number, chars: number): string {
  let out = ''
  let seq = fromSeq
  while (out.length < chars) {
    out += logLine(seq) + (seq % 50 === 49 ? '\n' : '\r\n')
    seq++
  }
  return out
}

/**
 * 模型里应该有的文本：盘上的字节去掉 BOM、行尾统一成**模型自己的**行尾。
 *
 * 模型 EOL 由多数行尾决定（Monaco `PieceTreeTextBufferFactory._getEOL`：CR+CRLF 过半即
 * CRLF），本 fixture 造的正是 CRLF 占多数，所以这里恒为 CRLF。`assertMixedEolFixture` 把
 * 这条前提钉住——它错了，是本 spec 的期望值错了，不是应用错了。
 */
function expectedModelText(diskText: string): string {
  const body = diskText.startsWith(BOM) ? diskText.slice(1) : diskText
  return body.replace(/\r\n|\r|\n/g, '\r\n')
}

/** fixture 自检：合成内容确实是「CRLF 占多数 + 混有裸 LF」，模型 EOL 才会是 CRLF。 */
function assertMixedEolFixture(diskText: string): void {
  const crlf = diskText.match(/\r\n/g)?.length ?? 0
  const lfOnly = diskText.match(/(?<!\r)\n/g)?.length ?? 0
  const crOnly = diskText.match(/\r(?!\n)/g)?.length ?? 0
  const total = crlf + lfOnly + crOnly
  if (lfOnly === 0 || !(crlf + crOnly > total / 2)) {
    throw new Error(
      `合成内容不是「CRLF 占多数且混有裸 LF」：crlf=${crlf} lf=${lfOnly} cr=${crOnly}`,
    )
  }
}

/**
 * 与探针 `getActiveEditorTextDigest` 同一算法（FNV-1a / UTF-16 code unit）。两边各一份是
 * 因为跨构建产物没法共享模块；小文件那条用例的期望值是一个手写字面量，两份实现一旦漂移
 * 它会立刻红。
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  }
  return hash >>> 0
}

const digestOf = (text: string): { length: number; hash: number } => ({
  length: text.length,
  hash: fnv1a(text),
})

/**
 * 原子重写：先写同目录临时文件再 rename 覆盖。
 *
 * **不能**直接 `writeFileSync` 盖 10MB——watcher 会在写入中途命中，读到的是截断内容，那会
 * 变成一次真实的全文删除编辑（与本用例要证的事无关，还会把结论引向错误方向）。rename 之后
 * 目标路径要么是旧内容、要么是新内容。
 */
function atomicRewrite(file: string, text: string): void {
  const tmp = `${file}.rewrite`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** 盘上的文本，以及按模型 EOL 归一化后应该出现在缓冲区里的那一份。 */
function readDiskExpectation(file: string): {
  diskText: string
  expected: string
  digest: { length: number; hash: number }
} {
  const diskText = readFileSync(file, 'utf8')
  const expected = expectedModelText(diskText)
  return { diskText, expected, digest: digestOf(expected) }
}

interface FlowCounters {
  readonly flow: ReadonlyArray<{ name: string; calls: number; chars: number }>
}
type Flow = { calls: number; chars: number }

function flowOf(counters: FlowCounters, name: string): Flow {
  const entry = counters.flow.find((f) => f.name === name)
  return entry ? { calls: entry.calls, chars: entry.chars } : { calls: 0, chars: 0 }
}

/** 区间增量：两次进程总计读数相减（`readHeapFlowTotals` 是非破坏性读法）。 */
function flowDelta(before: FlowCounters, after: FlowCounters, name: string): Flow {
  const from = flowOf(before, name)
  const to = flowOf(after, name)
  return { calls: to.calls - from.calls, chars: to.chars - from.chars }
}

/** 一批追加的出站量必须与这批追加的字符数同阶——既不是 0（没推），也不是 N 份文档。 */
function expectPushMatchesAppend(pushed: Flow, appendedChars: number, label: string): void {
  expect(pushed.chars, `${label}：追加了 ${appendedChars} chars 却一个字都没推`).toBeGreaterThan(0)
  expect(
    pushed.chars,
    `${label}：出站 ${pushed.chars} chars 远小于追加的 ${appendedChars} chars`,
  ).toBeGreaterThanOrEqual(Math.floor(appendedChars / 2))
  expect(
    pushed.chars,
    `${label}：出站 ${pushed.chars} chars 超出追加的 ${appendedChars} chars 这一档`,
  ).toBeLessThanOrEqual(appendedChars + ROUNDS_PER_BATCH * PUSH_SLACK_CHARS)
}

interface SyncStats {
  readonly openDocs: number
  readonly openChars: number
  readonly pendingChars: number
  readonly inflightChars: number
  readonly fullDocs: number
}

const readFlow = (page: Page): Promise<FlowCounters> =>
  page.evaluate(() => window.__E2E__!.getHeapFlowCounters())
const readSync = (page: Page): Promise<SyncStats> =>
  page.evaluate(() => window.__E2E__!.getDocumentSyncStats())
const readHeapUsed = (page: Page): Promise<number | null> =>
  page.evaluate(async () => (await window.__E2E__!.getMemoryPressure()).usedBytes)
const readDigest = (page: Page): Promise<{ length: number; hash: number } | undefined> =>
  page.evaluate(() => window.__E2E__!.getActiveEditorTextDigest())
const readDirty = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => window.__E2E__!.isActiveEditorDirty())
const payloadOf = (stats: SyncStats): number => stats.pendingChars + stats.inflightChars

/**
 * 等「这一轮的外部写入已经落到镜像上」。
 *
 * 信号取镜像的 `openChars`：它是模型长度（`getValueLength()`，不读正文），追加只让它变长，
 * 所以相等即意味着刷新读盘与最小编辑都跑完了。同时要求载荷归零——该发的发完、该 ack 的
 * ack 完（载荷在模型变化那一刻就非零，所以这条不会在推送之前提前成立），于是随后取到的
 * `docpush` 增量恰好描述这一轮。
 */
async function waitForMirrorLength(page: Page, expectedChars: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const stats = await readSync(page)
        return { openChars: stats.openChars, payload: payloadOf(stats), fullDocs: stats.fullDocs }
      },
      { timeout: ROUND_TIMEOUT_MS, intervals: [50, 100, 250, 500] },
    )
    .toEqual({ openChars: expectedChars, payload: 0, fullDocs: 0 })
}

/** 采样间隔：远小于 200ms 防抖，所以积压的那一段一定会被看到至少一次。 */
const SETTLE_SAMPLE_MS = 40

/**
 * 等这一轮落地，并返回这段窗口里见过的**载荷峰值**。
 *
 * 载荷是瞬时量：模型一变它先变成积压、推送开始后变成在途、ack 之后归零——settle 之后再读
 * 永远是 0，只有在窗口里连续采样才看得到它长到什么程度。放大器攒起来的东西正是在这里露头。
 */
async function settleRound(page: Page, expectedChars: number): Promise<number> {
  const deadline = Date.now() + ROUND_TIMEOUT_MS
  let maxPayload = 0
  for (;;) {
    const stats = await readSync(page)
    const payload = payloadOf(stats)
    maxPayload = Math.max(maxPayload, payload)
    if (stats.openChars === expectedChars && payload === 0 && stats.fullDocs === 0)
      return maxPayload
    if (Date.now() > deadline) {
      throw new Error(
        `这一轮没有落到镜像上：openChars=${stats.openChars}/${expectedChars} payload=${payload}`,
      )
    }
    await page.waitForTimeout(SETTLE_SAMPLE_MS)
  }
}

/** 工作区 watcher 武装之前写盘不会产生任何事件——等订阅落地，而不是与它竞速。 */
async function waitForWatchArmed(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.isWorkspaceWatchArmed()), { timeout: 30_000 })
    .toBe(true)
}

/** 打开文件并等初始镜像建立（`openDocs` 有记录 + `openChars` 是整篇长度）。 */
async function openMirrored(page: Page, file: string, chars: number): Promise<void> {
  await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), file)
  await expect
    .poll(async () => (await readSync(page)).openDocs, { timeout: OPEN_TIMEOUT_MS })
    .toBeGreaterThan(0)
  await waitForMirrorLength(page, chars)
}

/** 堆轨迹只打印：它是观察，不是判据。 */
function describeHeapTrajectory(readings: readonly number[]): string {
  const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(0)}MB`
  const sorted = [...readings].sort((a, b) => a - b)
  return (
    `first=${mb(readings[0] ?? 0)} last=${mb(readings[readings.length - 1] ?? 0)} ` +
    `min=${mb(sorted[0] ?? 0)} max=${mb(sorted[sorted.length - 1] ?? 0)} ` +
    `all=[${readings.map(mb).join(', ')}]`
  )
}

const LOG_FILE = 'client.log'

test.describe('external reload of an appended 10MB log', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, LOG_FILE), syntheticLog(LOG_TARGET_CHARS))
      },
    },
  })

  test('小追加只推增量，同内容重写零出站，载荷与堆都有界 @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    // 24 轮真实写盘，每轮一次 10MB 读盘与几次探针读取；CI 上被抢占时 30s 默认预算不够。
    test.setTimeout(300_000)
    if (!launchWorkspace) throw new Error('workspaceSeeder 未生效')
    const file = launchWorkspace.file(LOG_FILE)

    await workbench.waitForRestored()
    await waitForWatchArmed(page)

    // 合成内容自检：前提不成立时先失败在期望值这边，而不是让应用背锅。
    const seeded = readDiskExpectation(file)
    assertMixedEolFixture(seeded.diskText)
    expect(seeded.diskText.length).toBeGreaterThan(LOG_TARGET_CHARS)

    // 初始镜像：整篇 open 结束后才取基线——否则窗口里混着冷启的交通，也就分不清「这一轮
    // 推了多少」和「镜像本身推了多少」。这里同时证明管道是活的：没有它，后面「出站量很小」
    // 会被零调用蒙混成绿色。
    await openMirrored(page, file, seeded.expected.length)
    const opened = await readSync(page)
    expect(opened.openDocs, '镜像没有挂上：后面的读数都在描述一条不存在的管道').toBe(1)
    expect(opened.openChars).toBe(seeded.expected.length)
    expect(payloadOf(opened)).toBeLessThanOrEqual(PAYLOAD_BOUND_CHARS)
    expect(await readDigest(page)).toEqual(seeded.digest)
    expect(await readDirty(page)).toBe(false)

    // ---- 同内容原子重写：盘上字节没变，模型也不该动，更不该有任何出站编辑 ----
    // 修复前这里每次都推一份近全文 didChange（行尾混写 → 逐字节比对必然不等）。
    const rewriteBase = await readFlow(page)
    atomicRewrite(file, seeded.diskText)
    await expect
      .poll(async () => flowDelta(rewriteBase, await readFlow(page), 'extreload').calls, {
        timeout: ROUND_TIMEOUT_MS,
      })
      .toBeGreaterThan(0)
    // 读盘落地后再等一个完整的「防抖 + 发送」窗口，把「还没发」读成「没发」的可能排掉。
    await page.waitForTimeout(2_000)
    expect(
      flowDelta(rewriteBase, await readFlow(page), 'docpush'),
      '盘上字节一模一样，却推了一份出站编辑——行尾差异又被当成了全文变更',
    ).toEqual({ calls: 0, chars: 0 })
    expect(payloadOf(await readSync(page))).toBeLessThanOrEqual(PAYLOAD_BOUND_CHARS)
    expect(await readDigest(page)).toEqual(seeded.digest)
    expect(await readDirty(page)).toBe(false)

    // ---- 反复追加：每轮一次读盘、一次与追加量同阶的出站 ----
    const appendBase = await readFlow(page)
    let appendedChars = 0
    let pushedChars = 0
    let maxPayload = 0
    const heapReadings: number[] = []

    // 堆读数取「强制回收之后」的值。不这么做，读数里大部分是这一批刚产生、还没被回收的
    // 垃圾（每次 10MB 读盘就是几十 MB 的瞬时分配），轨迹描述的会是 GC 的时机而不是谁持有
    // 什么——那既不可判读也不可断言。强制回收走 CDP，与 `smoke.outlineRetention` 同一条路。
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    const liveHeapBytes = async (): Promise<number> => {
      await cdp.send('HeapProfiler.collectGarbage')
      const bytes = await readHeapUsed(page)
      if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) {
        throw new Error('无法读取有效的 GC 后堆大小，内存回归断言不能跳过')
      }
      return bytes
    }

    try {
      heapReadings.push(await liveHeapBytes())

      for (let batch = 0; batch < BATCHES; batch++) {
        const before = await readFlow(page)
        let batchAppended = 0
        for (let round = 0; round < ROUNDS_PER_BATCH; round++) {
          const chunk = syntheticAppend(1000 + batch * ROUNDS_PER_BATCH + round, APPEND_CHARS)
          appendFileSync(file, chunk)
          batchAppended += chunk.length
          // 每轮都从盘上取期望值：期望值必须来自真实字节，而不是我们对写入的记账。
          maxPayload = Math.max(
            maxPayload,
            await settleRound(page, readDiskExpectation(file).expected.length),
          )
        }

        const after = await readFlow(page)
        appendedChars += batchAppended
        pushedChars += flowDelta(before, after, 'docpush').chars
        expect(
          flowDelta(before, after, 'extreload').calls,
          `第 ${batch} 批没有读盘：外部写入没有触发刷新路径`,
        ).toBeGreaterThan(0)
        expectPushMatchesAppend(
          flowDelta(before, after, 'docpush'),
          batchAppended,
          `第 ${batch} 批`,
        )
        expect(await readDigest(page), `第 ${batch} 批模型与磁盘不一致`).toEqual(
          readDiskExpectation(file).digest,
        )
        expect(await readDirty(page)).toBe(false)

        heapReadings.push(await liveHeapBytes())
      }

      // 整段：出站总量与追加总量同阶，且**远**不到一份文档。
      const fileChars = (await readSync(page)).openChars
      const reloads = flowDelta(appendBase, await readFlow(page), 'extreload')
      expect(
        pushedChars,
        `出站 ${pushedChars} 相对追加 ${appendedChars} 超出一个数量级`,
      ).toBeLessThanOrEqual(appendedChars + ROUNDS * PUSH_SLACK_CHARS)
      expect(pushedChars).toBeLessThan(fileChars / 4)
      expect(maxPayload).toBeLessThanOrEqual(PAYLOAD_BOUND_CHARS)

      // 堆：打印轨迹 + 一条按读盘量算的倍数线（依据见 HEAP_GROWTH_BOUND_RELOAD_FACTOR）。
      expect(heapReadings).toHaveLength(BATCHES + 1)
      const growth = heapReadings[heapReadings.length - 1]! - heapReadings[0]!
      const reloadBytes = reloads.chars * 2
      console.log(
        `[docSyncExternalReload] rounds=${ROUNDS} fileChars=${fileChars} appended=${appendedChars} ` +
          `pushed=${pushedChars} reloads=${reloads.calls}x${reloads.chars}chars maxPayload=${maxPayload}`,
      )
      console.log(
        `[docSyncExternalReload] heap ${describeHeapTrajectory(heapReadings)} growth=${growth} reloadBytes=${reloadBytes} growthPerReloadBytes=${
          reloadBytes > 0 ? (growth / reloadBytes).toFixed(2) : 'n/a'
        }`,
      )
      expect(
        growth,
        `每读一次盘就把这一份文本留在堆里了：增长 ${growth} bytes 相对读盘量 ${reloadBytes} bytes 的比值 ` +
          `${reloadBytes > 0 ? (growth / reloadBytes).toFixed(2) : 'n/a'} 超过 ${HEAP_GROWTH_BOUND_RELOAD_FACTOR}` +
          `（1.0 即每次读盘留一整份）${describeHeapTrajectory(heapReadings)}`,
      ).toBeLessThan(reloadBytes * HEAP_GROWTH_BOUND_RELOAD_FACTOR)
    } finally {
      await cdp.detach().catch(() => {})
    }
  })
})

test.describe('same-content rewrite of a small mixed-EOL file', () => {
  /** 手写字面量：CRLF 两条 + 裸 LF 一条 + BOM，期望值是已知的（见 fnv1a 的注）。 */
  const SMALL_TEXT =
    '2026-09-19T00:00:00.000Z INFO  boot ok\r\n' +
    '2026-09-19T00:00:01.000Z INFO  shard listening\n' +
    '2026-09-19T00:00:02.000Z INFO  ready\r\n'
  const SMALL_EXPECTED = SMALL_TEXT.replace(/\r\n|\r|\n/g, '\r\n')
  const SMALL_DISK = `${BOM}${SMALL_TEXT}`
  const SMALL_FILE = 'small.log'

  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, SMALL_FILE), SMALL_DISK)
      },
    },
  })

  test('收敛到 no-op：没有假全文编辑，追加只推追加的那一段 @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    test.setTimeout(120_000)
    if (!launchWorkspace) throw new Error('workspaceSeeder 未生效')
    const file = launchWorkspace.file(SMALL_FILE)

    await workbench.waitForRestored()
    await waitForWatchArmed(page)

    // 手写期望值：这条同时把探针与 spec 两侧的 FNV-1a 钉在一起（漂移会先红在这里）。
    expect(SMALL_EXPECTED).toBe(
      '2026-09-19T00:00:00.000Z INFO  boot ok\r\n' +
        '2026-09-19T00:00:01.000Z INFO  shard listening\r\n' +
        '2026-09-19T00:00:02.000Z INFO  ready\r\n',
    )
    await openMirrored(page, file, SMALL_EXPECTED.length)
    expect(await readDigest(page)).toEqual(digestOf(SMALL_EXPECTED))
    expect(await readDirty(page)).toBe(false)

    // 同内容原子重写（盘上字节不变）：一次读盘，零出站编辑。
    const base = await readFlow(page)
    atomicRewrite(file, SMALL_DISK)
    await expect
      .poll(async () => flowDelta(base, await readFlow(page), 'extreload').calls, {
        timeout: ROUND_TIMEOUT_MS,
      })
      .toBeGreaterThan(0)
    await page.waitForTimeout(2_000)
    expect(
      flowDelta(base, await readFlow(page), 'docpush'),
      '盘上字节一模一样，却推了一份出站编辑——行尾差异又被当成了全文变更',
    ).toEqual({ calls: 0, chars: 0 })
    expect(await readDigest(page)).toEqual(digestOf(SMALL_EXPECTED))

    // 追加一段（以裸 LF 结尾，制造一次行尾归一化）：出站量就是这一段。
    const append = '2026-09-19T00:00:03.000Z INFO  tick=1\n'
    const appendBase = await readFlow(page)
    appendFileSync(file, append)
    const expected = readDiskExpectation(file).expected
    await waitForMirrorLength(page, expected.length)
    expectPushMatchesAppend(
      flowDelta(appendBase, await readFlow(page), 'docpush'),
      append.length,
      '追加',
    )
    expect(await readDigest(page)).toEqual(digestOf(expected))
    expect(await readDirty(page)).toBe(false)
  })
})
