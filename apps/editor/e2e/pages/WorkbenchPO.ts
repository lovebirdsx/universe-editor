import type { Page } from '@playwright/test'
import type {
  E2EDisposableLeakReport,
  E2EOpenWindow,
  E2EUpdateState,
} from '../../src/shared/e2e/contract.js'
import { ActivityBarPO } from './ActivityBarPO.js'
import { SideBarPO } from './SideBarPO.js'
import { StatusBarPO } from './StatusBarPO.js'
import { QuickInputPO } from './QuickInputPO.js'
import { EditorAreaPO } from './EditorAreaPO.js'
import { PanelPO } from './PanelPO.js'

export class WorkbenchPO {
  readonly activityBar: ActivityBarPO
  readonly sideBar: SideBarPO
  readonly statusBar: StatusBarPO
  readonly quickInput: QuickInputPO
  readonly editor: EditorAreaPO
  readonly panel: PanelPO

  constructor(readonly page: Page) {
    this.activityBar = new ActivityBarPO(page)
    this.sideBar = new SideBarPO(page)
    this.statusBar = new StatusBarPO(page)
    this.quickInput = new QuickInputPO(page)
    this.editor = new EditorAreaPO(page)
    this.panel = new PanelPO(page)
  }

  /** Execute a command through the renderer-side ICommandService. */
  async runCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
    return this.page.evaluate(
      ([cmd, params]) => window.__E2E__!.runCommand(cmd, ...(params as unknown[])),
      [id, args] as const,
    )
  }

  async getContextKey<T = unknown>(key: string): Promise<T> {
    return this.page.evaluate((k) => window.__E2E__!.getContextKey(k) as unknown, key) as Promise<T>
  }

  async lifecyclePhase(): Promise<string> {
    return this.page.evaluate(() => window.__E2E__!.getLifecyclePhase())
  }

  async waitForRestored(): Promise<void> {
    // 偶发：fixture 的 firstWindow() 可能在首次导航 commit 前返回，
    // 此时若评估正好与上下文切换重合，会抛 "Execution context was destroyed"。
    // 重新等探针就绪再评估一次即可恢复。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.page.evaluate(() => window.__E2E__!.whenRestored())
        return
      } catch (err) {
        if (attempt === 1 || !/Execution context was destroyed/.test(String(err))) throw err
        await this.page.waitForLoadState('domcontentloaded')
        await this.page.waitForFunction(() =>
          Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
        )
      }
    }
  }

  /** Open a workspace folder directly, bypassing the native dialog. */
  async openWorkspace(fsPath: string): Promise<void> {
    await this.page.evaluate((p) => window.__E2E__!.openWorkspace(p), fsPath)
  }

  /** Return the current workspace folder's fsPath, or undefined if none. */
  async getCurrentWorkspacePath(): Promise<string | undefined> {
    return this.page.evaluate(() => window.__E2E__!.getCurrentWorkspacePath())
  }

  /** Snapshot of all open application windows (id + folder fsPath + name). */
  async getOpenWindows(): Promise<readonly E2EOpenWindow[]> {
    return this.page.evaluate(() => window.__E2E__!.getOpenWindows())
  }

  /** Open a folder in a NEW window, bypassing the native folder dialog. */
  async openFolderInNewWindow(fsPath: string): Promise<void> {
    await this.page.evaluate((p) => window.__E2E__!.openFolderInNewWindow(p), fsPath)
  }

  /** fsPaths of the recent-workspaces list, most-recent first. */
  async getRecentWorkspacePaths(): Promise<readonly string[]> {
    return this.page.evaluate(() => window.__E2E__!.getRecentWorkspacePaths())
  }

  /** Remove a folder from the recent-workspaces list by fsPath. */
  async removeRecentWorkspace(fsPath: string): Promise<void> {
    await this.page.evaluate((p) => window.__E2E__!.removeRecentWorkspace(p), fsPath)
  }

  /** Return the active editor's resource URI string, or undefined if none. */
  async getActiveEditorUri(): Promise<string | undefined> {
    return this.page.evaluate(() => window.__E2E__!.getActiveEditorUri())
  }

  /** Return the number of editor groups currently open. */
  async getEditorGroupCount(): Promise<number> {
    return this.page.evaluate(() => window.__E2E__!.getEditorGroupCount())
  }

  /** Current auto-update state (status machine + versions). */
  async getUpdateState(): Promise<E2EUpdateState> {
    return this.page.evaluate(() => window.__E2E__!.getUpdateState())
  }

  /**
   * Read the Disposable leak report left in sessionStorage by the previous session.
   * Returns null if the previous session detected no leaks (or if the tracker
   * was not installed — i.e., the app was not launched in DEV or E2E mode).
   */
  async getLeakReport(): Promise<E2EDisposableLeakReport | null> {
    return this.page.evaluate(() => window.__E2E__!.getStoredLeakReport())
  }

  /** Number of currently registered SCM source controls. */
  getScmSourceControlCount(): Promise<number> {
    return this.page.evaluate(() => window.__E2E__!.getScmSourceControlCount())
  }

  /**
   * Fire the "Restart Editor" command and wait for the reloaded page to reach
   * Restored. Must be called instead of a bare runCommand + waitForRestored pair
   * because the restart is IPC-async: waitForRestored() would resolve on the
   * *old* (still-alive) page before the reload begins.
   *
   * Registers the navigation listener first, then fires the command, then
   * awaits the reload + probe + Restored in order.
   */
  async waitForRestartRestore(): Promise<void> {
    // Register listener BEFORE firing the command so we don't miss the reload event.
    const loaded = this.page.waitForEvent('load')

    // Fire restart. win.reload() is triggered via IPC (E2E mode uses reload not relaunch).
    void this.page
      .evaluate(() => void window.__E2E__!.runCommand('workbench.action.restartEditor'))
      .catch(() => {})

    // Wait for the page to reload and reach 'load' state.
    await loaded

    // Wait for the E2E probe to be reinstalled (set at LifecyclePhase.Ready).
    await this.page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )

    // Wait for the workbench to reach Restored.
    await this.page.evaluate(() => window.__E2E__!.whenRestored())
  }
}
