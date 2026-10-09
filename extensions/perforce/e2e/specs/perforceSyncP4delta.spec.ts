/*---------------------------------------------------------------------------------------------
 *  δ serves the plain get (@p1, @regression).
 *
 *  The editor's default get is `p4 sync` semantics — protect what p4 protects,
 *  never walk over uncollected local work — and p4delta answers exactly that
 *  since its `--sync` split (`--force` took the repair, `--sync` became the
 *  normal get). An engine swap of a WRITE is only proven by both halves, so
 *  every journey asserts the shape of the call AND the world after it:
 *
 *    - the δ argv carries `--sync -a` over the target the user asked for, while
 *      the native p4 argv log stays free of `sync` — the delegated child's env
 *      is stripped of that log, so a line there can only be the extension
 *      itself;
 *    - the bytes on disk moved (or, for the refusal, did not).
 *
 *  Two journeys, one cold launch each:
 *  1. A file get runs on δ, lands head, and leaves the sibling alone.
 *  2. A locally-modified file p4 refuses is reported as a refusal — folded into
 *     the answer, NOT re-served natively (the work the refusal protects is
 *     exactly what a second run would put at risk).
 *
 *  第三块覆盖 FORCE 修复（`--sync --force`）：δ 本地算范围，所以 include 内的排除项能存活——
 *  原生 filespec 表达不了，「无目标 get 整仓」会被它直接拒绝。可观测性全靠 `refused` 种子（正向 get 带不带 `-f` 写的字节一样）。
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateWhenRestored, mkTempDir, type WorkbenchPO } from '@universe-editor/e2e-harness'
import {
  readArgvLog,
  readHaveRev,
  readScopeLog,
  test,
  expect,
  toPosix,
  waitForPerforceCommands,
  writeScopeFile,
} from '../fixtures/perforceApp.js'
import type { P4SubmittedSeed, SeedFile } from '../fixtures/perforceApp.js'
import type { Page } from '@playwright/test'

// Depot head is one revision ahead of the have revision: the file is a get away
// from head, and a get for it really moves bytes.
const HAVE = 'have revision one\n'
const HEAD = 'head revision two\n'
const behind: SeedFile = {
  relPath: 'behind.txt',
  content: HAVE,
  headRev: 2,
  headContent: HEAD,
}
const SIBLING_HAVE = 'have sibling\n'
const SIBLING_HEAD = 'head sibling\n'
const sibling: SeedFile = {
  relPath: 'sibling.txt',
  content: SIBLING_HAVE,
  headRev: 2,
  headContent: SIBLING_HEAD,
}

// The `allwrite noclobber` shape: p4 skips this file with "can't update modified
// file" on the engine's stderr and carries on with exit 0.
const DRAFT = 'my uncollected work\n'
const REFUSED_HEAD = 'head refused\n'
const refused: SeedFile = {
  relPath: 'refused.txt',
  content: DRAFT,
  headRev: 2,
  headContent: REFUSED_HEAD,
  refused: true,
}

// 强制修复的种子。三个都是 `refused`——只有它的字节在「修复」与「空转」间不同；且都是 have #1、
// 草稿挡路、head #3，修复瞄准中间修订 #2（CL 4521 产出的那个），落到它才证明是所选 spec 而非 head。
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

const EXCLUDED_DRAFT = 'excluded draft\n'
const excludedDraft: SeedFile = {
  relPath: 'Content/gen/kept.txt',
  content: EXCLUDED_DRAFT,
  headRev: 3,
  headContent: 'excluded head\n',
  refused: true,
}

const OUTSIDE_DRAFT = 'outside draft\n'
const outside: SeedFile = {
  relPath: 'Outside/kept.txt',
  content: OUTSIDE_DRAFT,
  headRev: 3,
  headContent: 'outside head\n',
  refused: true,
}

const FORCE_SUBMITTED: readonly P4SubmittedSeed[] = [
  {
    changelist: '4521',
    user: 'e2e',
    // Unix 秒字符串，对齐 `p4 -ztag changes` 的输出。
    time: '1751600000',
    description: 'forced.txt to v2',
    rev: 2,
    files: [{ relPath: 'Content/forced.txt', action: 'edit', rev: 2 }],
  },
]

/** Fresh logs per journey: a shared file would make the "never asked natively"
 *  assertion depend on what the other journeys did. */
function makeLogs(): { delta: string; p4: string; scope: string } {
  return {
    delta: join(mkTempDir('ue2-p4delta-argv-'), 'p4delta.log'),
    p4: join(mkTempDir('ue2-p4-argv-'), 'p4.log'),
    scope: join(mkTempDir('ue2-p4delta-scope-'), 'scope.log'),
  }
}

/** δ's own gets, by the two flags that make one: `--sync` and the `-a` that
 *  turns the preview into the write. */
const deltaSyncLines = (log: string): string[] =>
  readArgvLog(log).filter((l) => /(^| )--sync( |$)/.test(l) && /(^| )-a( |$)/.test(l))

/** δ 自己、被调用方确认为「修复」的 get：`--force` 是它与普通 get 在线上的全部差别，
 *  所以有它才说明走的是 δ 而非原生 `-f`。 */
const deltaForceLines = (log: string): string[] =>
  deltaSyncLines(log).filter((l) => /(^| )--force( |$)/.test(l))

/** A `sync` the EXTENSION handed to p4 itself. The δ fake strips the log from
 *  the child it delegates to, so δ's internal p4 calls never appear here — a
 *  line is only ever the native engine. */
const nativeSyncLines = (log: string): string[] =>
  readArgvLog(log).filter((l) => /(^| )sync( |$)/.test(l))

/** The RANGE δ's own get runs cover, in the `<kind>:<path>` spelling the fake
 *  logs, compared separator-blind (`toPosix`): the extension hands local paths
 *  in `/` spelling, the fixture's `file()` is platform spelling, and what the
 *  assertion is about is WHICH path the engine was scoped to. The caller names
 *  targets and the engine resolves them against the client root's config, so
 *  `includes` is the range that survived that resolution. */
const syncRange = (scopeLog: string): string[] =>
  readScopeLog(scopeLog)
    .filter((resolution) => resolution.mode === 'sync')
    .flatMap((resolution) => resolution.includes)
    .map((entry) => toPosix(entry))

/** δ get 收到的 TYPED 目标（fake 记录的 `<kind>:<path>` 拼写）：配置收窄之前调用方自称的范围。 */
const syncTargets = (scopeLog: string): string[] =>
  readScopeLog(scopeLog)
    .filter((resolution) => resolution.mode === 'sync')
    .flatMap((resolution) => resolution.targets)
    .map((entry) => toPosix(entry))

/** Open the seeded workspace, wait for the provider + command registration. */
async function openSyncWorkspace(
  page: Page,
  workbench: WorkbenchPO,
  openDir: string,
): Promise<void> {
  await evaluateWhenRestored(page)
  await workbench.openWorkspace(openDir)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
      timeout: 60_000,
      message: 'perforce extension should register a source control for the workspace',
    })
    .toBeGreaterThan(0)
  await waitForPerforceCommands(workbench)
}

test.describe('@p1 perforce p4delta get', () => {
  test.describe('a plain get runs on delta', () => {
    const logs = makeLogs()
    test.use({
      p4Seeds: { files: [behind, sibling] },
      p4delta: {},
      p4ExtraEnv: {
        UNIVERSE_P4DELTA_ARGV_LOG: logs.delta,
        UNIVERSE_P4_FAKE_ARGV_LOG: logs.p4,
        UNIVERSE_P4DELTA_SCOPE_LOG: logs.scope,
      },
    })

    test('get latest lands the head revision through δ, and never asks p4 for it @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      await page.evaluate(
        (p) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: p }),
        perforce.file(behind.relPath),
      )

      // The world after it: head on disk. p4 refuses to lose local work — the
      // claim under test is that δ's get does too, not that it merely reported
      // success.
      await expect
        .poll(() => readFileSync(perforce.file(behind.relPath), 'utf8'), {
          timeout: 30_000,
          message: 'the get should write the head revision to disk',
        })
        .toBe(HEAD)
      // …and the get was scoped to the one file: the sibling is still on its
      // have revision.
      expect(readFileSync(perforce.file(sibling.relPath), 'utf8')).toBe(SIBLING_HAVE)

      // The shape of the call: δ got `--sync -a` over the ONE file the user asked
      // for, named as a positional target. `-a` is what separates the write from
      // the preview δ runs as its plan, the target is what keeps the run scoped to
      // that file, and `--no-scope-file` stays absent: the range was resolved WITH
      // the config, and only a user-confirmed out-of-scope target may drop it from
      // that resolution.
      const target = toPosix(perforce.file(behind.relPath))
      await expect
        .poll(() => deltaSyncLines(logs.delta).filter((l) => l.includes(target)).length, {
          timeout: 30_000,
          message: 'the get should hand δ --sync -a over the file',
        })
        .toBeGreaterThan(0)
      expect(deltaSyncLines(logs.delta).filter((l) => l.includes('--no-scope-file'))).toEqual([])
      await expect
        .poll(() => syncRange(logs.scope), {
          timeout: 30_000,
          message: 'the get should have been scoped to the file the user asked for',
        })
        .toContain(`file:${toPosix(perforce.file(behind.relPath))}`)

      // The other engine never ran a get at all. δ still did its scans, so this
      // is not the "no engine configured" world.
      expect(nativeSyncLines(logs.p4)).toEqual([])
      expect(readArgvLog(logs.delta).length).toBeGreaterThan(0)

      await expect(
        page
          .locator('[data-testid="notification-toast-item"]')
          .filter({ hasText: 'Updated 1 file(s)' }),
      ).toBeVisible({ timeout: 30_000 })
    })
  })

  test.describe('a refusal is folded, not re-served', () => {
    const logs = makeLogs()
    test.use({
      p4Seeds: { files: [refused] },
      p4delta: {},
      p4ExtraEnv: {
        UNIVERSE_P4DELTA_ARGV_LOG: logs.delta,
        UNIVERSE_P4_FAKE_ARGV_LOG: logs.p4,
        UNIVERSE_P4DELTA_SCOPE_LOG: logs.scope,
      },
    })

    test('a file p4 refuses is reported as refused and the draft survives @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      await page.evaluate(
        (p) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: p }),
        perforce.file(refused.relPath),
      )

      // The refusal reaches the user: p4's own message rides δ's stderr, and the
      // count in the dialog is what tells them why nothing moved.
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await expect(dialog).toContainText('not updated')
      // The way out is the lossless one, same as on the native path.
      await expect(dialog.getByRole('button', { name: 'Collect Changes' })).toBeVisible()

      // The draft is untouched — this is the whole point of the refusal.
      expect(readFileSync(perforce.file(refused.relPath), 'utf8')).toBe(DRAFT)

      // δ answered, so its answer stands: the refusal is NOT a failed run to
      // re-serve. A second, native attempt would be exactly the run that
      // overwrites what the refusal just protected.
      expect(deltaSyncLines(logs.delta).length).toBeGreaterThan(0)
      expect(nativeSyncLines(logs.p4)).toEqual([])
    })
  })

  test.describe('a force get runs on delta when the spec is expressible', () => {
    const logs = makeLogs()
    test.use({
      p4Seeds: {
        files: [forced, excludedDraft, outside],
        submitted: FORCE_SUBMITTED,
      },
      p4delta: {},
      p4ExtraEnv: {
        UNIVERSE_P4DELTA_ARGV_LOG: logs.delta,
        UNIVERSE_P4_FAKE_ARGV_LOG: logs.p4,
        UNIVERSE_P4DELTA_SCOPE_LOG: logs.scope,
      },
    })

    test('the repair covers the config range only, and a per-file spec stays on p4 @regression', async ({
      page,
      workbench,
      perforce,
      p4Workspace,
    }) => {
      test.setTimeout(150_000)
      // 让 δ 在这里有价值的范围：一个 include 内嵌一个排除。须在工作区打开前写好——
      // 扩展在激活时读它，δ 也会在它那侧读同一份文件。
      writeScopeFile(perforce.clientRoot, ['Content'], ['Content/gen'])
      await openSyncWorkspace(page, workbench, perforce.openDir)

      // 确认框按按钮匹配：picker 也带 `role=dialog`，而它弹出来时 picker 的行已经没了。
      const forceDialog = page.getByRole('dialog').filter({
        has: page.getByRole('button', { name: 'Force Get', exact: true }),
      })

      await test.step('the changelist force row repairs through δ, and only after the confirmation', async () => {
        // 不带参数：workspace 级 get，范围即日常范围。原生引擎直接拒绝这一款
        //（include 内嵌排除项没有对应 p4 filespec），所以文件能落地本身就是 δ 路由的证据。
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

        const dialog = forceDialog
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText('@4521')
        await expect(dialog).toContainText('cannot be undone')
        // 确认是破坏性执行前的最后一道闸：它还挂着时不得有任何写入。
        expect(readFileSync(perforce.file(forced.relPath), 'utf8')).toBe(FORCE_V1)

        await dialog.getByRole('button', { name: 'Force Get', exact: true }).click()

        // #2 既不是草稿（v1）也不是 head（v3）：越过 p4 的拒绝要靠 `-f`，
        // 停在 #2（而非 head）则要靠用户所选的那条 spec。
        await expect
          .poll(() => readFileSync(perforce.file(forced.relPath), 'utf8'), {
            timeout: 60_000,
            message: 'the forced get should overwrite the refused file with revision #2',
          })
          .toBe(FORCE_V2)
        await expect
          .poll(() => readHaveRev(p4Workspace.stateFile, forced.relPath), {
            timeout: 60_000,
            message: 'the repair should leave the client on the revision the user picked',
          })
          .toBe(2)

        // 本地算出的范围保护了什么：被排除的子树与范围外的路径，草稿和 have 修订都原样保留
        //（跑整仓目标的修复会冲掉前者，退回原生 include filespec 的会冲掉后者）。
        expect(readFileSync(perforce.file(excludedDraft.relPath), 'utf8')).toBe(EXCLUDED_DRAFT)
        expect(readFileSync(perforce.file(outside.relPath), 'utf8')).toBe(OUTSIDE_DRAFT)
        expect(readHaveRev(p4Workspace.stateFile, excludedDraft.relPath)).toBe(1)
        expect(readHaveRev(p4Workspace.stateFile, outside.relPath)).toBe(1)

        // 调用的形状：修复以 `--sync --force -a` 带上所选 CL 到达 δ，δ 再按配置解析它。
        await expect
          .poll(() => deltaForceLines(logs.delta).length, {
            timeout: 30_000,
            message: 'the repair should have been handed to δ with --force',
          })
          .toBeGreaterThan(0)
        expect(deltaForceLines(logs.delta).find((l) => l.includes('--to 4521'))).toBeDefined()
        await expect
          .poll(() => syncTargets(logs.scope), {
            timeout: 30_000,
            message: 'the repair should have named the whole workspace as its target',
          })
          .toContain(`directory:${toPosix(perforce.clientRoot)}`)
        await expect
          .poll(() => syncRange(logs.scope), {
            timeout: 30_000,
            message: 'the repair should have been scoped to the config include',
          })
          .toContain(`directory:${toPosix(perforce.file('Content'))}`)
        expect(syncRange(logs.scope)).not.toContain(
          `directory:${toPosix(perforce.file('Content/gen'))}`,
        )
        // 只有用户确认过的范围外目标才可让解析丢掉配置；无目标 get 永远不会。
        expect(deltaForceLines(logs.delta).filter((l) => l.includes('--no-scope-file'))).toEqual([])

        // 只有确认框点名的那一个引擎跑了修复：扩展没把任何 sync 交给 p4 本身。
        expect(nativeSyncLines(logs.p4)).toEqual([])

        await expect(
          page
            .locator('[data-testid="notification-toast-item"]')
            .filter({ hasText: 'Updated 1 file(s)' }),
        ).toBeVisible({ timeout: 30_000 })
      })

      await test.step('a per-file force spec has no δ form and stays on p4', async () => {
        // 日志在整次启动内是累积的，所以「这轮没新增」是与上一步的修复比较，而不是空日志。
        const repairsSoFar = deltaForceLines(logs.delta).length
        void page
          .evaluate(
            (p) => void window.__E2E__!.runCommand('perforce.sync', { resourceUri: p }),
            perforce.file(forced.relPath),
          )
          .catch(() => {})

        const quickInput = page.getByTestId('quick-input')
        await expect(
          quickInput.getByText('Force-get: a specific revision…', { exact: true }),
        ).toBeVisible({ timeout: 30_000 })
        await quickInput.getByText('Force-get: a specific revision…', { exact: true }).click()
        const prompt = page.getByPlaceholder('4', { exact: true })
        await expect(prompt).toBeVisible({ timeout: 30_000 })
        await prompt.fill('3')
        await prompt.press('Enter')

        const dialog = forceDialog
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText('#3')
        await dialog.getByRole('button', { name: 'Force Get', exact: true }).click()

        // v3 是 head，而先前的拒绝在没有 `-f` 时会停在 v2，字节因此证明这轮确实按用户所给 spec 强拉。
        await expect
          .poll(() => readFileSync(perforce.file(forced.relPath), 'utf8'), {
            timeout: 60_000,
            message: 'the per-file force get should land revision #3',
          })
          .toBe(FORCE_V3)

        // ……而它落在 p4 而非 δ：逐文件 `#rev` 正是引擎契约没有对应拼写的形状。
        await expect
          .poll(
            () =>
              nativeSyncLines(logs.p4).filter(
                (l) =>
                  /(^| )-f( |$)/.test(l) && toPosix(l).includes(`${toPosix(forced.relPath)}#3`),
              ).length,
            { timeout: 30_000, message: 'the per-file force spec should have run on p4' },
          )
          .toBeGreaterThan(0)
        expect(deltaForceLines(logs.delta).length).toBe(repairsSoFar)
      })
    })
  })
})
