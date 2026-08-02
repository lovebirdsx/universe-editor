/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/common/themeExtensionPoints.ts
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '@universe-editor/platform'

export interface ThemeData {
  readonly id: string
  readonly label?: string
  // File icon themes use null for the built-in Universe Material entry
  // (settingsId null, VSCode "None" parity).
  readonly settingsId?: string | null
}

/**
 * 扩展主题注册表（VSCode `ThemeRegistry<T>` 的对等物，去扩展增量 diff 的简化版）：
 * 注册、按 id / settingsId / 扩展位置查找，主题集变化时发事件。
 */
export class ExtensionThemeRegistry<T extends ThemeData> {
  private readonly themes: T[] = []
  private readonly _onDidChangeThemes = new Emitter<void>()
  readonly onDidChangeThemes: Event<void> = this._onDidChangeThemes.event

  constructor(
    private readonly defaultTheme?: T,
    private readonly onDuplicate?: (theme: T) => void,
  ) {}

  registerTheme(theme: T): void {
    this.registerThemes([theme])
  }

  /**
   * Register a batch atomically: consumers watching onDidChangeThemes (theme
   * picker waiting for the first registration, schema enum refresh) see the
   * whole batch at once instead of each intermediate prefix.
   */
  registerThemes(themes: readonly T[]): void {
    if (themes.length === 0) {
      return
    }
    for (const theme of themes) {
      const existing = this.findThemeById(theme.id)
      if (existing) {
        this.onDuplicate?.(theme)
        this.themes.splice(this.themes.indexOf(existing), 1, theme)
      } else {
        this.themes.push(theme)
      }
    }
    this._onDidChangeThemes.fire()
  }

  deregisterTheme(theme: T): void {
    this.deregisterThemes([theme])
  }

  deregisterThemes(themes: readonly T[]): void {
    let changed = false
    for (const theme of themes) {
      const index = this.themes.indexOf(theme)
      if (index !== -1) {
        this.themes.splice(index, 1)
        changed = true
      }
    }
    if (changed) {
      this._onDidChangeThemes.fire()
    }
  }

  getThemes(): readonly T[] {
    return this.themes
  }

  findThemeById(id: string | undefined, defaultId?: string): T | undefined {
    let fallback = this.defaultTheme
    for (const theme of this.themes) {
      if (theme.id === id) {
        return theme
      }
      if (defaultId !== undefined && theme.id === defaultId) {
        fallback = theme
      }
    }
    return fallback
  }

  findThemeBySettingsId(settingsId: string | undefined, defaultSettingsId?: string): T | undefined {
    let fallback = this.defaultTheme
    for (const theme of this.themes) {
      if (theme.settingsId !== undefined && theme.settingsId === settingsId) {
        return theme
      }
      if (defaultSettingsId !== undefined && theme.settingsId === defaultSettingsId) {
        fallback = theme
      }
    }
    return fallback
  }

  findThemeByExtensionLocation<P>(
    extensionLocation: P,
    getLocation: (theme: T) => P | undefined,
  ): readonly T[] {
    return this.themes.filter((t) => getLocation(t) === extensionLocation)
  }
}
