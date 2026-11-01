/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keeps the shared workspace file listing (mentionFileSearch cache, consumed
 *  by Ctrl+P quick open and the @-mention popover) fresh and warm:
 *    - any file change / watcher restart invalidates the cache, so the long
 *      TTL never serves stale results for long;
 *    - shortly after the workspace is ready, pre-warms the listing so the
 *      first Ctrl+P of a session doesn't pay the full disk walk. Idle-based
 *      prewarm (`runWhenIdle`) was unreliable on multi-window sessions — a
 *      freshly restored window is essentially never idle, so the walk only
 *      ever started on the user's first keystroke.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  Disposable,
  IFileSearchService,
  IFileWatcherService,
  IWorkspaceService,
  toDisposable,
  URI,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  invalidateMentionFileCache,
  loadWorkspaceFiles,
  focusScopeForMention,
} from '../services/acp/mentionFileSearch.js'
import { IExcludeService } from '../services/exclude/ExcludeService.js'
import { IFocusScopeService } from '../services/focus/FocusScopeService.js'

// 启动后立刻 prewarm 会和 restore/layout 抢 main 进程 I/O；延迟几秒让首屏先稳定，
// 但又不等 idle（多窗口下可能永远等不到）。与 PREWARM_BUDGET_MS 正交：前者是"何时开始"，
// 后者是"开始后最多走多久"。
export const PREWARM_DELAY_MS = 3_000
// 病态工作区的全盘走查是分钟级的主进程 I/O，而预热只是"让首次 Ctrl+P 少等一次"，
// 不值这个价：超时的走查会被主进程整份丢弃（残缺子集会把"子集外"呈现成"搜不到"），
// 之后完全由击键兜底搜索接管。预热不带 warmListing，超时也不会拉起磁盘清单构建——
// 那要等用户打开 Ctrl+P 或第一次兜底击键。
export const PREWARM_BUDGET_MS = 5_000

export class WorkspaceFileListingContribution extends Disposable implements IWorkbenchContribution {
  // Prewarm walks the whole workspace; on a pathological tree that is minutes
  // of main-process I/O, so it must die with the contribution, not linger.
  private readonly _prewarmCts = new CancellationTokenSource()
  private _prewarmTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileWatcherService private readonly _watcher: IFileWatcherService,
    @IFileSearchService private readonly _fileSearch: IFileSearchService,
    @IExcludeService private readonly _exclude: IExcludeService,
    @IFocusScopeService private readonly _focus: IFocusScopeService,
    // 尾随的普通参数（非注入服务）：ContributionService 走 createInstance(ctor)，
    // 运行时按装饰器索引拼服务参数、此位置收到 undefined 被默认值吃掉。注意两个
    // 后果：① createInstance 的重载在类型层匹配不上本类（GetLeadingNonServiceArgs
    // 推不出「带默认值的 number 不是服务」），测试只能直接 new；② 此位置之后
    // 不得再追加任何 @I... 注入参数——参数会整体错位且无报错（prewarmDelayMs 会
    // 拿到那个服务实例）。
    prewarmDelayMs: number = PREWARM_DELAY_MS,
  ) {
    super()
    this._register(
      toDisposable(() => {
        this._prewarmCts.dispose(true)
        if (this._prewarmTimer !== undefined) clearTimeout(this._prewarmTimer)
      }),
    )
    this._register(
      this._watcher.onDidChangeFiles((events) => {
        const root = this._workspace.current?.folder
        if (!root) return
        invalidateMentionFileCache(root)
        // 文件内容修改不改变文件集合；只有新增/删除才推进失效水位，避免每次
        // 保存都让下一次「必须给确定结论」的搜索等一次重建。
        if (events.some((event) => event.type !== 'modified')) this._invalidateListing(root)
      }),
    )
    // Events during a watcher crash gap are lost — rebuild from scratch.
    this._register(
      this._watcher.onDidRestart(() => {
        const root = this._workspace.current?.folder
        if (!root) return
        invalidateMentionFileCache(root)
        this._invalidateListing(root)
      }),
    )
    // A session that ends with files created while the editor was closed never
    // sees a watcher event for them; the on-disk listing may also predate them.
    this._register(
      this._workspace.onDidChangeWorkspace((workspace) => {
        if (workspace?.folder) this._invalidateListing(workspace.folder)
      }),
    )
    // A focus-scope change partitions the cache; stale listings for the old
    // scope must not survive it.
    this._register(
      this._focus.onDidChange(() => invalidateMentionFileCache(this._workspace.current?.folder)),
    )
    // whenReady only ever resolves today, but the interface doesn't guarantee
    // it — swallow a rejection rather than leak an unhandled one.
    void this._schedulePrewarm(prewarmDelayMs).catch(() => undefined)
  }

  /**
   * Mark the shared on-disk search listing stale. Fire-and-forget: invalidation
   * is a hint and must never reject out of a watcher callback (an unreachable
   * remote daemon or a disposed service may fail here).
   */
  private _invalidateListing(root: URI | undefined): void {
    if (!root) return
    try {
      void Promise.resolve(this._fileSearch.invalidateListing?.(root)).catch(() => undefined)
    } catch {
      // A disposed channel may throw synchronously; invalidation is only a hint.
    }
  }

  private async _schedulePrewarm(delayMs: number): Promise<void> {
    await this._workspace.whenReady
    if (this._store.isDisposed) return
    // A disk listing adopted from an earlier session may predate files created
    // while the editor was closed (no watcher event exists for them). Mark it
    // stale; only searches that must give a definitive answer wait for the rebuild.
    this._invalidateListing(this._workspace.current?.folder)
    this._prewarmTimer = setTimeout(() => {
      this._prewarmTimer = undefined
      void this._prewarm()
    }, delayMs)
  }

  private async _prewarm(): Promise<void> {
    const root = this._workspace.current?.folder
    if (!root || this._store.isDisposed) return
    await loadWorkspaceFiles(
      root,
      this._fileSearch,
      {
        dirNames: this._exclude.getDirNameIgnores(),
        excludeGlobs: this._exclude.getSearchExcludeGlobs(),
        useIgnoreFiles: this._exclude.getUseIgnoreFiles(),
        timeoutMs: PREWARM_BUDGET_MS,
      },
      this._prewarmCts.token,
      focusScopeForMention(this._focus),
    ).catch(() => undefined)
  }
}
