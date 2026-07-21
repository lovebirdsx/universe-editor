/*---------------------------------------------------------------------------------------------
 *  Simple file dialog (P1) — files.simpleDialog.enable parity.
 *
 *  打开文件夹 / 打开文件命令不再弹原生系统框, 而是渲染进程内基于 QuickInput 的
 *  目录浏览器. 这里验证真实交互: 回车/点击文件夹进入目录而不是关闭浮层, 选中文件
 *  打开编辑器, 选中文件夹切换工作区, 以及切换隐藏文件按钮.
 *
 *  起始目录取自 workspace.current.folder, 所以每个用例先 openWorkspace 到一个自建
 *  的确定性临时目录树. 命令内部 await pick, 触发必须 fire-and-forget 以避免死锁.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { expect, test } from '../fixtures/sharedApp.js'

/**
 * tmpDir/
 *   childdir/
 *     grandchild/        (folder — visible in both open-file and open-folder modes)
 *     note.txt           (file — visible only in open-file mode)
 *   top.txt              (file)
 *   .hidden.txt          (dotfile — hidden until the toggle button is pressed)
 */
async function makeTree(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-sfd-'))
  await fs.mkdir(path.join(tmpDir, 'childdir', 'grandchild'), { recursive: true })
  await fs.writeFile(path.join(tmpDir, 'childdir', 'note.txt'), 'hello', 'utf8')
  await fs.writeFile(path.join(tmpDir, 'top.txt'), 'top', 'utf8')
  await fs.writeFile(path.join(tmpDir, '.hidden.txt'), 'secret', 'utf8')
  return tmpDir
}

test.describe('@p1 simple file dialog', () => {
  // @serial: this case switches the workspace twice in one test (openWorkspace
  // then OK-confirm a subfolder), driving two back-to-back parcel watcher
  // re-subscribes on the main process. @parcel/watcher's windows backend has a
  // cross-process native race — when several Electron instances (e2e workers)
  // re-subscribe concurrently it can fault (0xC0000005) the main process, which
  // surfaces here as "Target page has been closed". Single-instance runs never
  // trip it, so we pin this case to a single worker. See `pnpm e2e` (serial pass).
  test(
    'openFolder navigates into a folder and OK switches the workspace',
    {
      tag: '@serial',
    },
    async ({ page, workbench }) => {
      const tmpDir = await makeTree()
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)
      await expect.poll(() => workbench.getCurrentWorkspacePath()).toContain('ue2-sfd-')

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.files.openFolder')
      })
      await workbench.quickInput.waitForVisible()
      await expect(workbench.quickInput.input).toBeFocused()
      await expect(page.getByTestId('quick-input-title')).toBeVisible()

      // Folder mode lists folders, not files.
      await expect(page.getByRole('option').filter({ hasText: 'childdir' })).toBeVisible()
      await expect(page.getByRole('option').filter({ hasText: 'top.txt' })).toHaveCount(0)

      // Entering a folder must keep the dialog open (regression: Enter used to close it).
      await page.getByRole('option').filter({ hasText: 'childdir' }).click()
      await expect(workbench.quickInput.dialog).toBeVisible()
      await expect(workbench.quickInput.input).toHaveValue(/childdir[\\/]$/)
      await expect(page.getByRole('option').filter({ hasText: 'grandchild' })).toBeVisible()

      // OK confirms the current folder (childdir) as the selection.
      await workbench.quickInput.dialog.getByTestId('quick-input-ok').click()
      await workbench.quickInput.waitForHidden()
      await expect.poll(() => workbench.getCurrentWorkspacePath()).toContain('childdir')
    },
  )

  test(
    'openFile navigates into a folder and selecting a file opens it',
    { tag: '@serial' },
    async ({ page, workbench }) => {
      const tmpDir = await makeTree()
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)
      await expect.poll(() => workbench.getCurrentWorkspacePath()).toContain('ue2-sfd-')

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.files.openFile')
      })
      await workbench.quickInput.waitForVisible()

      // File mode lists both folders and files.
      await expect(page.getByRole('option').filter({ hasText: 'childdir' })).toBeVisible()
      await expect(page.getByRole('option').filter({ hasText: 'top.txt' })).toBeVisible()

      // Enter a folder, then pick the file inside it.
      await page.getByRole('option').filter({ hasText: 'childdir' }).click()
      await expect(workbench.quickInput.dialog).toBeVisible()
      const note = page.getByRole('option').filter({ hasText: 'note.txt' })
      await expect(note).toBeVisible()
      await note.click()

      await workbench.quickInput.waitForHidden()
      await expect.poll(() => workbench.getActiveEditorUri()).toContain('note.txt')
    },
  )

  test(
    'the toggle button reveals hidden dotfiles',
    { tag: '@serial' },
    async ({ page, workbench }) => {
      const tmpDir = await makeTree()
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)
      await expect.poll(() => workbench.getCurrentWorkspacePath()).toContain('ue2-sfd-')

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.files.openFile')
      })
      await workbench.quickInput.waitForVisible()

      // Dotfiles are hidden by default.
      await expect(page.getByRole('option').filter({ hasText: 'top.txt' })).toBeVisible()
      await expect(page.getByRole('option').filter({ hasText: '.hidden.txt' })).toHaveCount(0)

      // The toolbar button flips showDotFiles and re-lists.
      await workbench.quickInput.dialog.getByTestId('quick-input-button').click()
      await expect(page.getByRole('option').filter({ hasText: '.hidden.txt' })).toBeVisible()

      await page.keyboard.press('Escape')
      await workbench.quickInput.waitForHidden()
    },
  )

  // Regression: pressing the mouse inside the path input (e.g. starting a text
  // selection) and releasing it over the backdrop used to synthesize a click on
  // the backdrop and dismiss the whole dialog. The dialog must survive it.
  test(
    'dragging a selection out of the input past the backdrop keeps the dialog open',
    { tag: '@serial' },
    async ({ page, workbench }) => {
      const tmpDir = await makeTree()
      await workbench.waitForRestored()
      await workbench.openWorkspace(tmpDir)
      await expect.poll(() => workbench.getCurrentWorkspacePath()).toContain('ue2-sfd-')

      await page.evaluate(() => {
        void window.__E2E__!.runCommand('workbench.action.files.openFile')
      })
      await workbench.quickInput.waitForVisible()

      const inputBox = await workbench.quickInput.input.boundingBox()
      const overlayBox = await workbench.quickInput.overlay.boundingBox()
      if (!inputBox || !overlayBox) throw new Error('missing layout boxes')

      // Press inside the input, drag up-left into the backdrop area (well above
      // the dialog), release there.
      await page.mouse.move(inputBox.x + 20, inputBox.y + inputBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(overlayBox.x + 10, overlayBox.y + 10, { steps: 5 })
      await page.mouse.up()

      // Dialog stays open; not dismissed by the cross-boundary drag.
      await expect(workbench.quickInput.dialog).toBeVisible()

      // A genuine backdrop click (press + release both on the backdrop) still closes it.
      await page.mouse.click(overlayBox.x + 10, overlayBox.y + 10)
      await workbench.quickInput.waitForHidden()
    },
  )
})
