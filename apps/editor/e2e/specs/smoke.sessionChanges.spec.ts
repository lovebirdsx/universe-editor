/*---------------------------------------------------------------------------------------------
 *  Session Changes (会话级 diff) smoke test (@p1).
 *
 *  全链路烟雾：注入一个 stdio agent，它在 prompt 时把一个文件真实写到磁盘，并推送带
 *  `_meta.claudeCode.toolResponse.{filePath, structuredPatch}` 的 `Write` tool_call。断言：
 *    - SessionChangeTrackerService 记录该变更（读盘 current + 逆推 baseline）；
 *    - Session Editor 右上角出现 `...` 菜单（Session Changes 入口在 overflow 内）；
 *    - 点击入口打开 Session Changes 容器，CHANGES 列表渲染出被修改文件一行；
 *    - 点击该行打开整文件 diff editor（typeId='diff'）。
 *
 *  数据通路（agent → structuredPatch → tracker → Side Bar 列表 → diff editor）此前只有
 *  单测覆盖；本 spec 在真实打包产物里跑全链路。
 *
 *  注意: sessionDiffAgent.cjs 是源码（不经过构建），spec 直接拿源码绝对路径喂给探针。
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SD_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'sessionDiffAgent.cjs')

const SHOW_CHANGES_CMD = 'workbench.action.agent.showSessionChanges'

test.describe('@p1 session changes', () => {
  test('a session Write surfaces a whole-file diff in the Session Changes list', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 1. 注入 session-diff agent 并设为默认。
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'sd',
      SD_AGENT_PATH,
    ] as const)

    // 2. newSession（默认 chat location 为 'editor'，会话作为全屏 editor 打开）。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 3. 右上角 overflow 菜单可见；Session Changes 不再作为 inline diff 图标出现。
    await expect(page.getByTestId('editor-title-overflow')).toBeVisible()
    await expect(page.locator(`[data-testid="view-title-action-${SHOW_CHANGES_CMD}"]`)).toHaveCount(
      0,
    )

    // 4. 发送 prompt（agent 写盘 + 推送 Write structuredPatch）。
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('go'))

    // 5. 打开 Session Changes 容器，列表渲染出被修改文件一行。
    await page.evaluate(
      ([cmd]) => {
        void window.__E2E__!.runCommand(cmd)
      },
      [SHOW_CHANGES_CMD] as const,
    )
    await expect(page.getByTestId('acp-changes-row')).toHaveCount(1)
    await expect(page.getByTestId('acp-changes-row')).toHaveAttribute('data-status', 'modified')

    // 5b. 右上角列表/树切换按钮可见且可点（切到树形不应破坏列表）。
    const toggle = page.getByTestId('session-changes-toggle-view-mode')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(page.getByTestId('acp-changes-row')).toHaveCount(1)
    await toggle.click()

    // 6. 点击行打开整文件 diff editor。
    await page.getByTestId('acp-changes-row').click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('diff')
  })

  test('an already-open diff tab refreshes in place after a second edit', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'sd',
      SD_AGENT_PATH,
    ] as const)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)

    // First edit + open the whole-file diff from the Session Changes list.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('go'))
    await page.evaluate(([cmd]) => void window.__E2E__!.runCommand(cmd), [
      SHOW_CHANGES_CMD,
    ] as const)
    await expect(page.getByTestId('acp-changes-row')).toHaveCount(1)
    await page.getByTestId('acp-changes-row').click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('diff')

    // The diff tab now shows the first edit's content. Poll until the live Monaco
    // models are mounted and reflect it.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified))
      .toBe('line one\nline two MODIFIED')

    // Second edit to the SAME file WITHOUT reopening the tab. The prompt text
    // contains "again", so the agent writes distinct content + a new hunk.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('go again'))

    // The still-open diff tab must refresh in place to the newer content.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified))
      .toBe('line one\nline two MODIFIED AGAIN')
    // Baseline (original side) stays the pre-session content.
    await expect(await page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.original)).toBe(
      'line one\nline two',
    )
  })

  test('an open diff refreshes when the user edits the source file (same group)', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    const diffFile = await openSessionDiff(page)

    // Diff shows the agent's edit.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified))
      .toBe('line one\nline two MODIFIED')

    // Open the source file in the same group (diff tab stays open behind it).
    await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), diffFile)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('file')

    // The user edits the file but does NOT save (dirty). This exercises the live
    // model-sync path — the file watcher never fires for unsaved edits. Poll the
    // edit until it lands: setActiveEditorText no-ops (returns false) until the
    // file editor's Monaco model has finished its async resolve, and on a cold
    // start the tab can flip to 'file' before that model exists.
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__E2E__!.setActiveEditorText('line one\nline two EDITED BY USER'),
        ),
      )
      .toBe(true)

    // Switch back to the diff via its tab (NOT the changes list — reopening from
    // the list would re-seed content from the tracker, masking the live-sync
    // path we are testing). Its modified side must reflect the unsaved edit.
    await page.getByRole('tab', { name: /\(Diff\)/ }).click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('diff')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified))
      .toBe('line one\nline two EDITED BY USER')
  })

  test('an open diff refreshes live when the source file is edited in a split group', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    // Set up the session + tracked change, but keep the diff CLOSED for now.
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'sd',
      SD_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('go'))
    await page.evaluate(([cmd]) => void window.__E2E__!.runCommand(cmd), [
      SHOW_CHANGES_CMD,
    ] as const)
    await expect(page.getByTestId('acp-changes-row')).toHaveCount(1)

    // Derive the file path from the changes row (open the diff once to read the
    // URI, then close it so it only ever mounts in the right group below).
    await page.getByTestId('acp-changes-row').click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('diff')
    const uri = await page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    const diffFile = fileURLToPath(uri!.replace(/^diff:/, ''))
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.closeActiveEditor'))

    // Open the source file, split right (copies the file into a new right group).
    await page.evaluate((p) => window.__E2E__!.openFileUri(p, { pinned: true }), diffFile)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('file')
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.splitEditorRight'))
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getEditorGroupCount())).toBe(2)

    // In the (active) right group, open the whole-file diff from the changes list.
    // Now: left group = file, right group = diff (diff mounts Monaco only here).
    await page.getByTestId('acp-changes-row').click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('diff')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified))
      .toBe('line one\nline two MODIFIED')

    // Edit the file in the LEFT group WITHOUT saving. The diff in the right group
    // must update live (shared Monaco model), even though it is not active. Poll
    // the edit until the left file editor's Monaco model has resolved (see the
    // same-group test for why a bare call can no-op on a cold start).
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.focusLeftGroup'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('file')
    await expect
      .poll(() =>
        page.evaluate(() => window.__E2E__!.setActiveEditorText('line one\nline two LIVE EDIT')),
      )
      .toBe(true)

    // Focus the right group (the diff) and assert its modified side followed.
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.focusRightGroup'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('diff')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified))
      .toBe('line one\nline two LIVE EDIT')
  })
})

/**
 * The built-in Perforce ignore layer, end to end.
 *
 * The core fixture activates no extensions, so there is no git and no perforce
 * source control — exactly the state the incident happened in (the extension was
 * installed but never activated, so `checkIgnore` answered nothing and every
 * build artifact became an inferred row). This case is what proves the fallback
 * reads the rules itself.
 *
 * The rule file sits in the workspace's PARENT, not in the workspace: the opened
 * folder is a subtree of the Perforce client root in the reported setup, so the
 * rules live above it. That is the only shape that drives the walk past the
 * workspace root (`scm.ignoreFiles.searchCeiling` defaults to 'filesystem') and
 * the out-of-workspace read. The parent here is the per-run temp root, which the
 * harness removes at teardown.
 *
 * The exact row count is also the guard against the filter catching its own
 * catches: an earlier revision watched the ancestor rule file, which the main
 * watcher realizes as a non-recursive watch on its DIRECTORY, so the rule file
 * itself showed up here as an inferred row.
 */
test.describe('@p1 session changes · built-in .p4ignore', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dirname(dir), '.p4ignore'), 'build/\n', 'utf8')
        mkdirSync(join(dir, 'src'), { recursive: true })
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
      },
    },
  })

  test('a build artifact dropped by .p4ignore never reaches the inferred list', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    test.setTimeout(180_000)
    await workbench.waitForRestored()
    if (!launchWorkspace) throw new Error('workspace seeder did not run')

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'sd',
      SD_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)

    // The workspace watch is armed in the idle phase (WorkspaceWatchContribution),
    // and the watcher only reports changes from the moment it subscribes — a
    // write before that produces NO event at all, which is what made this case
    // flake at roughly one run in five. The tree view papers over the gap with a
    // catch-up re-read; the session-diff fallback has no such thing, so wait for
    // the subscription instead of racing it.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.isWorkspaceWatchArmed()), {
        timeout: 30_000,
      })
      .toBe(true)

    // `shell` mode writes both paths and reports neither, so both rows can only
    // come from the fs-watch fallback — the same ingest path a build artifact
    // takes. Both land in one flush, so the kept row doubles as proof that the
    // flush ran at all (without it, a missing row proves nothing).
    await page.evaluate(([a, b]) => window.__E2E__!.sendAcpPrompt(`shell\n${a}\n${b}`), [
      launchWorkspace.file('build/out.log'),
      launchWorkspace.file('src/a.ts'),
    ] as const)

    await page.evaluate(([cmd]) => void window.__E2E__!.runCommand(cmd), [
      SHOW_CHANGES_CMD,
    ] as const)

    const rows = page.getByTestId('acp-changes-row')
    await expect(rows).toHaveCount(1, { timeout: 60_000 })
    await expect(rows).toContainText('a.ts')
    await expect(page.getByTestId('acp-changes-inferred')).toHaveCount(1)

    // An absence assertion needs an explicit settle: the kept path's row is
    // created by the flush, the ignored path is dropped in the same pass, but a
    // second flush (say, the watcher reporting the tree a beat late) could still
    // add a row after the count above was satisfied. Outlast both the grace
    // delay and a recompute before trusting the count.
    await page.waitForTimeout(5_000)
    await expect(rows).toHaveCount(1)
  })
})

/**
 * Install the session-diff agent, start a session, run one prompt (agent writes
 * the file + reports a Write), open the Session Changes list and click the row to
 * open the whole-file diff. Returns the on-disk path of the diffed file.
 */
async function openSessionDiff(page: import('@playwright/test').Page): Promise<string> {
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'sd',
    SD_AGENT_PATH,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
    .toBe(1)
  await page.evaluate(() => window.__E2E__!.sendAcpPrompt('go'))
  await page.evaluate(([cmd]) => void window.__E2E__!.runCommand(cmd), [SHOW_CHANGES_CMD] as const)
  await expect(page.getByTestId('acp-changes-row')).toHaveCount(1)
  await page.getByTestId('acp-changes-row').click()
  await expect.poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId())).toBe('diff')
  // The diff's editor id is `diff:${originalUri}`; strip the prefix to recover the
  // real file URI (the agent wrote to os.tmpdir()), then to an fs path.
  const uri = await page.evaluate(() => window.__E2E__!.getActiveEditorUri())
  return fileURLToPath(uri!.replace(/^diff:/, ''))
}
