/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/iconRegistry.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * IconRegistry —— VSCode `iconRegistry` 的裁剪对等物。
 *
 * 应用使用的 codicon 在此登记（id → 默认 fontCharacter）。产品图标主题按 id
 * 覆盖字形：渲染层只用 `codicon-<id>` 类名，主题的样式表改写该类的
 * `content` / `font-family`（VSCode `iconsStyleSheet` 同款机制）。
 *
 * `defaults` 可以是另一个图标的 ThemeIcon 引用（继承链：新 id 复用旧图标的
 * 定义，产品图标主题解析时沿链向上找定义）。
 */

import { Emitter, type Event } from '../base/event.js'

/** A reference to a registered icon by id (`{ id: 'add' }`). */
export interface ThemeIcon {
  readonly id: string
}

// eslint-disable-next-line @typescript-eslint/no-namespace -- VSCode parity API (ThemeIcon.isThemeIcon)
export namespace ThemeIcon {
  export function isThemeIcon(value: unknown): value is ThemeIcon {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as ThemeIcon).id === 'string' &&
      (value as { fontCharacter?: unknown }).fontCharacter === undefined
    )
  }
}

export interface IconFontSource {
  readonly location: string
  readonly format: string
}

export interface IconFontDefinition {
  readonly src: readonly IconFontSource[]
  readonly weight?: string
  readonly style?: string
}

export interface IconDefinition {
  /** Undefined for the default font (codicon). */
  readonly font?: { readonly id: string; readonly definition: IconFontDefinition }
  readonly fontCharacter: string
}

export type IconDefaults = ThemeIcon | IconDefinition

export interface IconContribution {
  readonly id: string
  readonly description: string | undefined
  readonly defaults: IconDefaults
}

export interface IIconRegistry {
  readonly onDidChange: Event<void>
  registerIcon(id: string, defaults: IconDefaults, description?: string): ThemeIcon
  deregisterIcon(id: string): void
  getIcons(): readonly IconContribution[]
  getIcon(id: string): IconContribution | undefined
}

class IconRegistry implements IIconRegistry {
  private readonly _icons = new Map<string, IconContribution>()
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange: Event<void> = this._onDidChange.event

  registerIcon(id: string, defaults: IconDefaults, description?: string): ThemeIcon {
    const existing = this._icons.get(id)
    if (existing !== undefined) {
      if (description !== undefined && existing.description === undefined) {
        this._icons.set(id, { id, description, defaults: existing.defaults })
      }
      return { id }
    }
    this._icons.set(id, { id, description, defaults })
    this._onDidChange.fire()
    return { id }
  }

  deregisterIcon(id: string): void {
    if (this._icons.delete(id)) {
      this._onDidChange.fire()
    }
  }

  getIcons(): readonly IconContribution[] {
    return [...this._icons.values()]
  }

  getIcon(id: string): IconContribution | undefined {
    return this._icons.get(id)
  }
}

const registry = new IconRegistry()

export function getIconRegistry(): IIconRegistry {
  return registry
}

/** Resolve a contribution's default definition, following ThemeIcon inheritance chains. */
export function getIconDefinition(
  contribution: IconContribution,
  reg: IIconRegistry = registry,
): IconDefinition | undefined {
  let definition = contribution.defaults
  while (ThemeIcon.isThemeIcon(definition)) {
    const c = reg.getIcon(definition.id)
    if (!c) {
      return undefined
    }
    definition = c.defaults
  }
  return definition
}
