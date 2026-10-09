/*---------------------------------------------------------------------------------------------
 *  S — Release notes (P1).
 *
 *  验证「Show Release Notes」命令打开 releaseNotes 类型的编辑器标签页，以及页面本身真的把随包
 *  release-notes.json 渲染出来：每个版本一个 section（版本头 + 正文）、版本严格降序、索引条可跳转。
 *
 *  不在这里覆盖的（各有归属，避免用真实数据断言不存在的东西）：
 *  - 升级后自动弹出的「What's New」区间链路由 ReleaseNotesContribution 单测覆盖；
 *  - `doc:` / `command:` / 被拒协议的链接行为由 ReleaseNotesEditor 的 DOM 用例覆盖——随包的历史
 *    归档正文是逐字转义的纯文本，没有任何链接可点，e2e 无从断言导航。
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_VERSION = (
  JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string
  }
).version

/** Numeric segment compare (0.10.0 > 0.9.0) — mirrors the app's own ordering rule. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

test.describe('@p1 release notes', () => {
  test('Show Release Notes opens a releaseNotes editor', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.showReleaseNotes')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('releaseNotes')
  })

  test('renders every shipped version, newest first, with the index able to jump', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.runCommand('workbench.action.showReleaseNotes')

    const sections = page.locator('[data-testid="release-note-version"]')
    await expect.poll(() => sections.count(), { timeout: 15000 }).toBeGreaterThan(1)

    const versions = (
      await sections.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-version') ?? ''),
      )
    ).filter((version) => version !== '')

    // Newest first, and never a version the running app has not shipped yet.
    for (let i = 1; i < versions.length; i++) {
      expect(compareVersions(versions[i - 1]!, versions[i]!)).toBeGreaterThan(0)
    }
    expect(compareVersions(versions[0]!, APP_VERSION)).toBeLessThanOrEqual(0)

    // The section renders a version header (version + date) and a body that went through
    // the markdown renderer rather than being dumped as one text node.
    const first = sections.first()
    const firstText = (await first.innerText()).trim()
    expect(firstText).toContain(versions[0]!)
    expect(firstText.length).toBeGreaterThan(20)
    await expect.poll(() => first.locator('time').count()).toBe(1)
    await expect
      .poll(() => first.locator('h2, h3, ul, ol, p, blockquote').count())
      .toBeGreaterThan(0)

    // One index chip per version; the oldest one must scroll its section into view.
    const chips = page.locator('[data-testid="release-notes-index"] button')
    await expect.poll(() => chips.count()).toBe(versions.length)

    const lastTop = () => sections.last().evaluate((node) => node.getBoundingClientRect().top)
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    expect(await lastTop()).toBeGreaterThan(viewportHeight)

    await chips.last().click()
    await expect
      .poll(async () => {
        const top = await lastTop()
        return top >= 0 && top < viewportHeight
      })
      .toBe(true)
  })
})
