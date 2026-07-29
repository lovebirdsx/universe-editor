/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 主题文件 watcher —— watch 当前主题文件及其 include 链，磁盘变更时经
 * WorkbenchThemeService.reloadCurrentTheme() 重载并重新应用（热更新）。
 * 走 IFileWatcherService.watchOutOfWorkspace（主题文件在内置扩展目录，
 * 通常位于工作区之外）。
 */

import {
  Disposable,
  IFileWatcherService,
  type IDisposable,
  type ILogger,
  NullLogger,
  type URI,
} from '@universe-editor/platform'
import { IOutOfWorkspaceWatchService } from '../files/outOfWorkspaceWatchService.js'
import type { WorkbenchThemeService } from './workbenchThemeService.js'

export class ThemeFileWatcher extends Disposable {
  private _watchedKeys = new Set<string>()
  private _watchHandle: IDisposable | undefined

  constructor(
    private readonly _themeService: WorkbenchThemeService,
    private readonly _fileWatcherService: IFileWatcherService,
    private readonly _outOfWorkspaceWatch: IOutOfWorkspaceWatchService,
    logger: ILogger = new NullLogger(),
  ) {
    super()
    this._register(
      this._themeService.onDidColorThemeChange(() => {
        this._rewatch(logger)
      }),
    )
    this._register(
      this._fileWatcherService.onDidChangeFiles((events) => {
        if (events.some((e) => this._watchedKeys.has(e.resource.toString()))) {
          logger.debug('theme file changed on disk; reloading')
          void this._themeService.reloadCurrentTheme()
        }
      }),
    )
    this._rewatch(logger)
  }

  private _rewatch(logger: ILogger): void {
    const theme = this._themeService.getColorThemeData()
    const files: URI[] =
      theme.location !== undefined && theme.loadedFiles.length > 0
        ? [...theme.loadedFiles]
        : theme.location !== undefined
          ? [theme.location]
          : []
    this._watchedKeys = new Set(files.map((f) => f.toString()))
    if (files.length > 0) {
      logger.debug(`watching theme files: ${files.map((f) => f.path).join(', ')}`)
    }
    this._watchHandle?.dispose()
    this._watchHandle = this._outOfWorkspaceWatch.watch(files)
  }
}
