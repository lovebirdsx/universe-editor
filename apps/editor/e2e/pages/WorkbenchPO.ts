import type { Page } from '@playwright/test'
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

  /** Return the active editor's resource URI string, or undefined if none. */
  async getActiveEditorUri(): Promise<string | undefined> {
    return this.page.evaluate(() => window.__E2E__!.getActiveEditorUri())
  }
}
