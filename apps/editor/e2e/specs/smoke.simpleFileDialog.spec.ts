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
  test('openFolder navigates into a folder and OK switches the workspace', async ({
    page,
    workbench,
  }) => {
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
  })

  test('openFile navigates into a folder and selecting a file opens it', async ({
    page,
    workbench,
  }) => {
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
  })

  test('the toggle button reveals hidden dotfiles', async ({ page, workbench }) => {
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
  })
})
