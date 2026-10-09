/*---------------------------------------------------------------------------------------------
 *  δ + `.p4delta-scope` 下的「已同步」标记（回归复现）。
 *
 *  现场（用户报）：工作区 client root 下有 `.p4delta-scope`，include 只列子目录；用 δ 引擎
 *  在**图谱**里拉取（普通与强制），成功提示后图谱的「已同步」标记（行徽章 + 工具栏
 *  `· 已同步至 #N`）不前进。δ 关闭（p4 时代）时正常。
 *
 *  账本的两把尺（`docs/graph.md`「本地同步点」）：
 *    - 询问尺 = 图谱 tab 的 scope（未 scoped 的整工作区 tab ⇒ 打开的文件夹）；
 *    - 记账尺 = 本次 get 的真实范围（无显式 scope 的 get ⇒ 日常范围自身的条目
 *      ＝ 打开的文件夹 ∩ `.p4delta-scope`）。
 *  带配置时两把尺不再相同：记账尺只剩 include 的子目录。`lookupSyncPoint` 只让**覆盖**
 *  询问 scope 的记录作答，于是配置一存在，整工作区 tab 就再也答不出来 —— 而它恰恰是
 *  唯一不会自己探测（宽 scope 探测几十秒）的 tab，所以标记会一直停在 `#? (click to query)`。
 *
 *  本文件把这条路走成断言：账本查询（`perforce-graph.getSyncPoint`，renderer 读的就是它）
 *  与工具栏那句话都要落在被拉下来的那个 CL 上。
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '@universe-editor/temp-root'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import {
  readArgvLog,
  readScopeLog,
  test,
  expect,
  toPosix,
  waitForPerforceCommands,
  writeScopeFile,
} from '../fixtures/perforceApp.js'
import type { P4SubmittedSeed, SeedFile } from '../fixtures/perforceApp.js'
import type { Page } from '@playwright/test'

const V1 = 'v1\n'
const V2 = 'v2\n'

// have #1 / head #2：一次 get 真的会搬字节，4521 就是那个落点。
const behind: SeedFile = {
  relPath: 'Content/behind.txt',
  content: V1,
  haveRev: 1,
  haveContent: V1,
  headRev: 2,
  headContent: V2,
  revisions: { '1': V1, '2': V2 },
}

const SUBMITTED: readonly P4SubmittedSeed[] = [
  {
    changelist: '4521',
    user: 'e2e',
    time: '1751600000',
    description: 'behind.txt to v2',
    rev: 2,
    files: [{ relPath: 'Content/behind.txt', action: 'edit', rev: 2 }],
  },
]

const UNKNOWN = '#? (click to query)'

// 强制拉取的种子：本地草稿挡路（`refused`），只有 `-f` 才写得进去——正向 get 带不带 `-f`
// 写的字节一样，草稿是 force 唯一的可观测差异。have #1、head #3、目标 4521 产出 #2：
// 落在 #2 而非 head 同时证明跑的是所选 spec。
const FORCE_V1 = 'forced v1\n'
const FORCE_V2 = 'forced v2\n'
const FORCE_V3 = 'forced v3\n'
const forced: SeedFile = {
  relPath: 'Content/forced.txt',
  content: FORCE_V1,
  headRev: 3,
  headContent: FORCE_V3,
  revisions: { '1': FORCE_V1, '2': FORCE_V2, '3': FORCE_V3 },
  refused: true,
}

const FORCE_SUBMITTED: readonly P4SubmittedSeed[] = [
  {
    changelist: '4521',
    user: 'e2e',
    time: '1751600000',
    description: 'forced.txt to v2',
    rev: 2,
    files: [{ relPath: 'Content/forced.txt', action: 'edit', rev: 2 }],
  },
]

/** 现场的范围配置：include 只列 client root 下的一个子目录。 */
function scopeIncludeSubdir(perforce: { clientRoot: string }): void {
  writeScopeFile(perforce.clientRoot, ['Content'], [])
}

function makeLogs(): { delta: string; p4: string; scope: string } {
  return {
    delta: join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log'),
    p4: join(mkTempDir('ue2-p4-argv-'), 'p4.log'),
    scope: join(mkTempDir('ue2-p4delta-scope-'), 'scope.log'),
  }
}

const deltaSyncLines = (log: string): string[] =>
  readArgvLog(log).filter((l) => /(^| )--sync( |$)/.test(l) && /(^| )-a( |$)/.test(l))

const nativeSyncLines = (log: string): string[] =>
  readArgvLog(log).filter((l) => /(^| )sync( |$)/.test(l))

/** δ 自己、被调用方确认为「修复」的 get：`--force` 是它与普通 get 在线上的全部差别。 */
const deltaForceLines = (log: string): string[] =>
  deltaSyncLines(log).filter((l) => /(^| )--force( |$)/.test(l))

const syncRange = (scopeLog: string): string[] =>
  readScopeLog(scopeLog)
    .filter((resolution) => resolution.mode === 'sync')
    .flatMap((resolution) => resolution.includes)
    .map((entry) => toPosix(entry))

async function openGraphWorkspace(
  page: Page,
  workbench: WorkbenchPO,
  openDir: string,
): Promise<void> {
  test.setTimeout(120_000)
  await evaluateWhenRestored(page)
  await workbench.openWorkspace(openDir)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
      timeout: 60_000,
      message: 'perforce extension should register a source control for the workspace',
    })
    .toBeGreaterThan(0)
  await waitForPerforceCommands(workbench)
  await workbench.runCommand('perforce-graph.view')
  await expect(page.locator('[data-testid="perforceGraph-editor"]')).toBeVisible()
}

/** 账本对「未 scoped 的整工作区 tab」的答案 —— renderer 每次 load/revalidate 读的就是这条。 */
async function syncPointOf(page: Page): Promise<{ id: string; source: string } | null> {
  return page.evaluate(
    () =>
      window.__E2E__!.runCommand('perforce-graph.getSyncPoint', { wholeRepo: false }) as Promise<
        { id: string; source: string } | null
      >,
  )
}

test.describe('@p1 perforce graph sync point, delta engine with a scope file', () => {
  const logs = makeLogs()
  test.use({
    p4Seeds: { files: [behind], submitted: SUBMITTED },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: logs.delta,
      UNIVERSE_P4_FAKE_ARGV_LOG: logs.p4,
      UNIVERSE_P4DELTA_SCOPE_LOG: logs.scope,
    },
  })

  test('a workspace-wide get answers the unscoped graph tab @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    scopeIncludeSubdir(perforce)
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(line).toHaveText(UNKNOWN)

    // 工作区级的拉取（SCM 面板 / 状态栏 / 命令面板那条「无显式 scope」的 get）。
    await page.evaluate(() => void window.__E2E__!.runCommand('perforce.syncLatest'))

    await expect
      .poll(() => readFileSync(perforce.file(behind.relPath), 'utf8'), {
        timeout: 60_000,
        message: 'the get should write head revision #2 to disk',
      })
      .toBe(V2)
    // δ 真的按配置的范围跑过：include 内的子目录就是它解析出的范围。
    await expect
      .poll(() => deltaSyncLines(logs.delta).length, { timeout: 30_000 })
      .toBeGreaterThan(0)
    expect(nativeSyncLines(logs.p4)).toEqual([])
    await expect.poll(() => syncRange(logs.scope), { timeout: 30_000 }).toContain(
      `directory:${toPosix(perforce.file('Content'))}`,
    )

    // 拉取把整个工作区的范围搬到了 4521：账本与工具栏都必须这么说。
    await expect.poll(() => syncPointOf(page), { timeout: 30_000 }).toMatchObject({ id: '4521' })
    await expect(line).toHaveText('#4521', { timeout: 30_000 })
  })
})

test.describe('@p1 perforce graph sync point, a graph row get with a scope file', () => {
  const logs = makeLogs()
  test.use({
    p4Seeds: { files: [behind], submitted: SUBMITTED },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: logs.delta,
      UNIVERSE_P4_FAKE_ARGV_LOG: logs.p4,
      UNIVERSE_P4DELTA_SCOPE_LOG: logs.scope,
    },
  })

  test('answers the tab that started it @regression', async ({ page, workbench, perforce }) => {
    scopeIncludeSubdir(perforce)
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(line).toHaveText(UNKNOWN)

    // 4521 是唯一一行（也是 head），所以这次 get 不带时间旅行的确认框。
    await editor.locator('[data-id="4521"]').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await menu.getByText('Get This Revision', { exact: true }).click()

    await expect
      .poll(() => readFileSync(perforce.file(behind.relPath), 'utf8'), { timeout: 60_000 })
      .toBe(V2)
    await expect.poll(() => deltaSyncLines(logs.delta).length, { timeout: 30_000 }).toBeGreaterThan(0)

    await expect.poll(() => syncPointOf(page), { timeout: 30_000 }).toMatchObject({ id: '4521' })
    await expect(line).toHaveText('#4521', { timeout: 30_000 })
    await expect(editor.locator('[data-id="4521"]')).toContainText('Synced')
  })
})

// 对拍：同一形状、同一配置，但跑在原生 p4 上。若这条也红，则记账尺与询问尺的错位来自
// 范围配置本身（引擎无关）；若只有 δ 那条红，就是 δ 路线的记账问题。
test.describe('@p1 perforce graph sync point, the same get on p4 with a scope file', () => {
  test.use({ p4Seeds: { files: [behind], submitted: SUBMITTED } })

  test('answers the unscoped graph tab @regression', async ({ page, workbench, perforce }) => {
    scopeIncludeSubdir(perforce)
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(line).toHaveText(UNKNOWN)

    await page.evaluate(() => void window.__E2E__!.runCommand('perforce.syncLatest'))

    await expect
      .poll(() => readFileSync(perforce.file(behind.relPath), 'utf8'), { timeout: 60_000 })
      .toBe(V2)
    await expect.poll(() => syncPointOf(page), { timeout: 30_000 }).toMatchObject({ id: '4521' })
    await expect(line).toHaveText('#4521', { timeout: 30_000 })
  })
})

// force 与普通 get 共用 `runSync` 的记账块，但走 δ 的另一档（类表、`handoff`、`force` 标志都
// 不同），而现场报告的两条症状就是「拉取」与「强制拉取」——所以单独一条钉住：无参强制 get
// 同样只覆盖日常范围，徽章也必须前进。
test.describe('@p1 perforce graph sync point, a force get with a scope file', () => {
  const logs = makeLogs()
  test.use({
    p4Seeds: { files: [forced], submitted: FORCE_SUBMITTED },
    p4delta: {},
    p4ExtraEnv: {
      UNIVERSE_P4DELTA_ARGV_LOG: logs.delta,
      UNIVERSE_P4_FAKE_ARGV_LOG: logs.p4,
      UNIVERSE_P4DELTA_SCOPE_LOG: logs.scope,
    },
  })

  test('a workspace-wide force get answers the unscoped graph tab @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    scopeIncludeSubdir(perforce)
    await openGraphWorkspace(page, workbench, perforce.openDir)
    const editor = page.locator('[data-testid="perforceGraph-editor"]')
    const line = editor.getByTestId('perforceGraph-syncPoint')
    await expect(line).toHaveText(UNKNOWN)

    // 命令面板那条无参强制 get：选「按 changelist 强制获取」→ 填 4521 → 确认框。
    // 图谱编辑器没有「活动文件」（`getActiveEditorFile` 只认文件编辑器），所以这次
    // get 不带显式 scope —— 正是记账尺被日常范围收窄的那一款。
    await page.evaluate(() => void window.__E2E__!.runCommand('perforce.sync'))
    const quickInput = page.getByTestId('quick-input')
    await expect(
      quickInput.getByText('Force-get: as of a changelist…', { exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    await quickInput.getByText('Force-get: as of a changelist…', { exact: true }).click()
    const prompt = page.getByPlaceholder('12345', { exact: true })
    await expect(prompt).toBeVisible({ timeout: 30_000 })
    await prompt.fill('4521')
    await prompt.press('Enter')

    const dialog = page.getByRole('dialog').filter({
      has: page.getByRole('button', { name: 'Force Get', exact: true }),
    })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Force Get', exact: true }).click()

    // 草稿挡路：不带 `-f` 的 get 会跳过它，所以「草稿变 V2」本身就是 force 到达 p4 的证据；
    // 停在 #2（而非 head #3）则证明跑的是用户所选的那条 spec。
    await expect
      .poll(() => readFileSync(perforce.file(forced.relPath), 'utf8'), {
        timeout: 60_000,
        message: 'the forced get should overwrite the refused file with revision #2',
      })
      .toBe(FORCE_V2)
    await expect
      .poll(() => deltaForceLines(logs.delta).length, {
        timeout: 30_000,
        message: 'the repair should have been handed to δ with --force',
      })
      .toBeGreaterThan(0)
    await expect
      .poll(() => syncRange(logs.scope), { timeout: 30_000 })
      .toContain(`directory:${toPosix(perforce.file('Content'))}`)
    expect(nativeSyncLines(logs.p4)).toEqual([])

    await expect.poll(() => syncPointOf(page), { timeout: 30_000 }).toMatchObject({ id: '4521' })
    await expect(line).toHaveText('#4521', { timeout: 30_000 })
  })
})
