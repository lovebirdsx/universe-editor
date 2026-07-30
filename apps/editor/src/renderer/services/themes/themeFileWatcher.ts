/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 主题文件 watcher —— watch 当前主题文件及其 include 链，磁盘变更时经
 * WorkbenchThemeService.reloadCurrentTheme() 重载并重新应用（热更新）。
 * 颜色主题、文件图标主题、产品图标主题共用同一 watcher：任一主题切换时
 * 重挂监听集合，变更事件按归属路由到对应的 reload。走
 * IFileWatcherService.watchOutOfWorkspace（主题文件在内置扩展目录，
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
  /** file key → which reload to trigger. */
  private _watchedTargets = new Map<string, 'color' | 'fileIcon' | 'productIcon'>()
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
      this._themeService.onDidFileIconThemeChange(() => {
        this._rewatch(logger)
      }),
    )
    this._register(
      this._themeService.onDidProductIconThemeChange(() => {
        this._rewatch(logger)
      }),
    )
    this._register(
      this._fileWatcherService.onDidChangeFiles((events) => {
        const targets = new Set<'color' | 'fileIcon' | 'productIcon'>()
        for (const e of events) {
          const target = this._watchedTargets.get(e.resource.toString())
          if (target !== undefined) {
            targets.add(target)
          }
        }
        if (targets.has('color')) {
          logger.debug('color theme file changed on disk; reloading')
          void this._themeService.reloadCurrentTheme()
        }
        if (targets.has('fileIcon')) {
          logger.debug('file icon theme file changed on disk; reloading')
          void this._themeService.reloadCurrentFileIconTheme()
        }
        if (targets.has('productIcon')) {
          logger.debug('product icon theme file changed on disk; reloading')
          void this._themeService.reloadCurrentProductIconTheme()
        }
      }),
    )
    this._rewatch(logger)
  }

  private _rewatch(logger: ILogger): void {
    const targets = new Map<string, 'color' | 'fileIcon' | 'productIcon'>()
    const files: URI[] = []
    const add = (uris: readonly URI[], target: 'color' | 'fileIcon' | 'productIcon'): void => {
      for (const uri of uris) {
        const key = uri.toString()
        if (!targets.has(key)) {
          targets.set(key, target)
          files.push(uri)
        }
      }
    }

    const colorTheme = this._themeService.getColorThemeData()
    if (colorTheme.location !== undefined) {
      add(
        colorTheme.loadedFiles.length > 0 ? colorTheme.loadedFiles : [colorTheme.location],
        'color',
      )
    }
    const fileIconTheme = this._themeService.getFileIconThemeData()
    if (fileIconTheme.location !== undefined) {
      add(
        fileIconTheme.loadedFiles.length > 0 ? fileIconTheme.loadedFiles : [fileIconTheme.location],
        'fileIcon',
      )
    }
    const productIconTheme = this._themeService.getProductIconThemeData()
    if (productIconTheme.location !== undefined) {
      add(
        productIconTheme.loadedFiles.length > 0
          ? productIconTheme.loadedFiles
          : [productIconTheme.location],
        'productIcon',
      )
    }

    this._watchedTargets = targets
    if (files.length > 0) {
      logger.debug(`watching theme files: ${files.map((f) => f.path).join(', ')}`)
    }
    this._watchHandle?.dispose()
    this._watchHandle = this._outOfWorkspaceWatch.watch(files)
  }
}
