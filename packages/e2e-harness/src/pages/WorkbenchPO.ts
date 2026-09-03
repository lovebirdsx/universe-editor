import { expect, type Page } from '@playwright/test'
import type {
  E2EDisposableLeakReport,
  E2EOpenWindow,
  E2EUpdateState,
} from '@universe-editor/e2e-contract'
import { ActivityBarPO } from './ActivityBarPO.js'
import { SideBarPO } from './SideBarPO.js'
import { StatusBarPO } from './StatusBarPO.js'
import { QuickInputPO } from './QuickInputPO.js'
import { EditorAreaPO } from './EditorAreaPO.js'
import { PanelPO } from './PanelPO.js'

/**
 * Teardown gate: unmount React + snapshot the Disposable tracker on `page`, and
 * fail the test if anything leaked. Shared by the fixtures' teardown and by
 * self-launching specs (which build their own Electron instance and must invoke
 * this on the final live window before closing it). Destructive — unmounts the
 * workbench, so call it last, after the test body has finished.
 *
 * If the window is already gone (closed or quit before we could snapshot it) we
 * cannot inspect it synchronously — that is the expected path for specs whose
 * subject IS closing windows (workbench.action.quit), so we skip silently: the
 * renderer's beforeunload handler still captured any leak and persisted it to
 * <userData>/last-disposable-leak.json, which the next bootstrap consumes and
 * surfaces. A context destroyed mid-evaluate on a still-open page (reload race)
 * is unexpected and keeps a visible warn. Non-teardown errors re-throw.
 */
export async function expectNoLeaks(page: Page): Promise<void> {
  if (page.isClosed()) return
  let report: E2EDisposableLeakReport | null
  try {
    report = await page.evaluate(() => window.__E2E__?.computeTeardownLeakReport() ?? null)
  } catch (err) {
    if (/Execution context was destroyed|Target (page|closed)/.test(String(err))) {
      if (page.isClosed()) return
      console.warn(
        '[expectNoLeaks] execution context destroyed before the in-process leak snapshot; ' +
          'any leak from this session was persisted to last-disposable-leak.json ' +
          '(surfaced on next bootstrap).',
      )
      return
    }
    throw err
  }
  expect(
    report,
    report ? `${report.count} Disposable leak(s) detected at teardown:\n${report.details}` : '',
  ).toBeNull()
}

/**
 * Teardown gate: fail the test if the extension host pushed any unhandled
 * rejection during the session. Non-destructive (reads the accumulated list from
 * the probe), unlike {@link expectNoLeaks}; shared by the fixtures' teardown and
 * self-launching specs. A window already closed before we can snapshot it is the
 * expected path for specs whose subject IS closing windows — skip silently.
 */
export async function expectNoExtHostUnhandledRejections(page: Page): Promise<void> {
  if (page.isClosed()) return
  let rejections: string[]
  try {
    rejections = await page.evaluate(() => window.__E2E__?.getExtHostUnhandledRejections() ?? [])
  } catch (err) {
    if (isContextTeardownError(err)) {
      if (page.isClosed()) return
      console.warn(
        '[expectNoExtHostUnhandledRejections] execution context destroyed before the snapshot; ' +
          'skipping the gate.',
      )
      return
    }
    throw err
  }
  expect(
    rejections,
    rejections.length > 0
      ? `Extension host unhandled rejection(s) at teardown:\n${rejections.join('\n')}`
      : '',
  ).toEqual([])
}

/**
 * Recognize the two error-message variants Playwright surfaces for the same
 * mid-evaluate navigation race, so retry guards tolerate both:
 *   - "Execution context was destroyed": the evaluate was dispatched after the
 *     context had already been torn down.
 *   - "Resulting promise was garbage collected" (CDP "Promise was collected"):
 *     the awaitPromise had been registered but the context was destroyed
 *     afterwards, releasing the remote promise object before Playwright could
 *     await it.
 */
export function isContextTeardownError(err: unknown): boolean {
  return /Execution context was destroyed|Resulting promise was garbage collected|Promise was collected/.test(
    String(err),
  )
}

/**
 * Evaluate `whenRestored()` tolerating a mid-evaluate context teardown.
 *
 * Callers race a navigation: the fixture's firstWindow()/a self-launched
 * `electron.launch` may return before the first navigation commits, and a
 * restart reload may not be fully committed on slow CI. In both cases the
 * evaluate can coincide with a context switch and throw either teardown message
 * (see {@link isContextTeardownError}). Re-wait for the probe to be (re)installed
 * and evaluate again.
 *
 * Exported so self-launching specs (which don't use the `workbench` fixture)
 * reuse the same hardening instead of leaving a bare `page.evaluate(whenRestored)`.
 */
export async function evaluateWhenRestored(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.evaluate(() => window.__E2E__!.whenRestored())
      return
    } catch (err) {
      if (attempt === 2 || !isContextTeardownError(err)) throw err
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
    }
  }
}

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

  /**
   * Focus the active editor group and wait until Monaco actually owns DOM focus.
   *
   * `focusActiveEditorGroup` is fire-once: it focuses the Monaco instance looked
   * up from FileEditorRegistry, which is only registered after the model loads
   * asynchronously (FileEditor.tsx applyModel). On a cold first frame the
   * command can fire before the instance is registered and silently no-op,
   * leaving `editorFocus` false forever — a bare poll on the context key never
   * recovers because nothing re-fires the focus. Re-fire on every poll until the
   * key flips true.
   */
  async focusActiveEditorGroup(): Promise<void> {
    await expect
      .poll(async () => {
        await this.runCommand('workbench.action.focusActiveEditorGroup')
        return this.getContextKey<boolean>('editorFocus')
      })
      .toBe(true)
  }

  /**
   * Make the Explorer side bar visible, idempotently.
   *
   * `workbench.view.explorer` is a TOGGLE (ShowExplorerAction): with the side bar
   * already visible AND focused it CLOSES it. Whether the cold-start focus
   * restore has reached the side bar by the time a spec fires the command is a
   * race, so a bare `runCommand('workbench.view.explorer')` hides the Explorer on
   * roughly half the runs. The symptom is deceptive: the tree rows stay mounted
   * (side bar width 0), so `toBeVisible` on a row still passes and only the
   * subsequent click has nowhere to land. Fire only while the side bar is
   * actually hidden.
   */
  async showExplorer(): Promise<void> {
    await expect
      .poll(
        async () => {
          const visible = await this.getContextKey<boolean>('sideBarVisible')
          if (!visible) await this.runCommand('workbench.view.explorer')
          return visible
        },
        { timeout: 30_000, message: 'the Explorer side bar should end up visible' },
      )
      .toBe(true)
  }

  async lifecyclePhase(): Promise<string> {
    return this.page.evaluate(() => window.__E2E__!.getLifecyclePhase())
  }

  async waitForRestored(): Promise<void> {
    await this._evaluateWhenRestored()
  }

  /**
   * Wait for the one-shot bootstrap focus restore to land. Specs that focus the
   * terminal (or anything else) right after startup must await this, otherwise
   * the late restore steals focus back to the Explorer/editor.
   */
  async waitForBootstrapFocusSettled(): Promise<void> {
    await this.page.evaluate(() => window.__E2E__!.whenBootstrapFocusSettled())
  }

  private async _evaluateWhenRestored(): Promise<void> {
    await evaluateWhenRestored(this.page)
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

  /** Full text of the active editor's model, or undefined if no file editor. */
  async getActiveEditorText(): Promise<string | undefined> {
    return this.page.evaluate(() => window.__E2E__!.getActiveEditorText())
  }

  /** Replace the active editor's whole text (cursor resets to the top). */
  async setActiveEditorText(text: string): Promise<boolean> {
    return this.page.evaluate((t) => window.__E2E__!.setActiveEditorText(t), text)
  }

  /** Set the active editor's single selection (1-based). */
  async setActiveEditorSelection(
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ): Promise<boolean> {
    return this.page.evaluate(
      ([sl, sc, el, ec]) => window.__E2E__!.setActiveEditorSelection(sl, sc, el, ec),
      [startLineNumber, startColumn, endLineNumber, endColumn] as const,
    )
  }

  /** Place an empty cursor at a 1-based position in the active editor. */
  async setActiveEditorCursor(lineNumber: number, column: number): Promise<boolean> {
    return this.page.evaluate(([l, c]) => window.__E2E__!.setActiveEditorSelection(l, c, l, c), [
      lineNumber,
      column,
    ] as const)
  }

  /** Command ids of every keybinding whose first chord equals `key`. */
  async getKeybindingCommandsForKey(key: string): Promise<string[]> {
    return this.page.evaluate((k) => window.__E2E__!.getKeybindingCommandsForKey(k), key)
  }

  /** Return the number of editor groups currently open. */
  async getEditorGroupCount(): Promise<number> {
    return this.page.evaluate(() => window.__E2E__!.getEditorGroupCount())
  }

  /** Id of the currently active editor group (matches the DOM `data-group-id`). */
  async getActiveGroupId(): Promise<string | undefined> {
    return this.page.evaluate(() => window.__E2E__!.getActiveGroupId())
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

  /**
   * Teardown gate — unmount React, snapshot the tracker, and fail if anything
   * leaked. Thin wrapper over the module-level {@link expectNoLeaks}.
   */
  async expectNoLeaks(): Promise<void> {
    await expectNoLeaks(this.page)
  }

  /**
   * Teardown gate — fail if the extension host pushed any unhandled rejection.
   * Thin wrapper over the module-level {@link expectNoExtHostUnhandledRejections}.
   */
  async expectNoExtHostUnhandledRejections(): Promise<void> {
    await expectNoExtHostUnhandledRejections(this.page)
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
      .evaluate(() => void window.__E2E__!.runCommand('workbench.action.reloadWindow'))
      .catch(() => {})

    // Wait for the page to reload and reach 'load' state.
    await loaded

    // Wait for the E2E probe to be reinstalled (set at LifecyclePhase.Ready).
    await this.page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )

    // Wait for the workbench to reach Restored. On slow CI the reload may not
    // be fully committed yet, so tolerate a mid-evaluate context teardown.
    await this._evaluateWhenRestored()
  }
}
