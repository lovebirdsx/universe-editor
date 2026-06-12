/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's Action2 abstraction (platform/actions/common/actions.ts).
 *  Declaratively register a command together with its menu placements and
 *  keybindings; one call fans out to CommandsRegistry / MenuRegistry /
 *  KeybindingsRegistry.
 *--------------------------------------------------------------------------------------------*/

import { combinedDisposable, IDisposable, markAsSingleton } from '../base/lifecycle.js'
import { ServicesAccessor } from '../di/instantiation.js'
import { CommandsRegistry, ICommandMetadata } from './commandRegistry.js'
import { ContextKeyExpr, ContextKeyExpression } from './contextKeyExpr.js'
import { IKeybindingItem, KeybindingsRegistry } from './keybindingRegistry.js'
import { IMenuItem, MenuId, MenuRegistry } from './menuRegistry.js'

export interface ICommandActionTitle {
  /** Display title. */
  value: string
  /** Original (English) form for diagnostics. Optional. */
  original?: string
}

export interface IAction2Menu {
  id: MenuId
  group?: string
  order?: number
  when?: ContextKeyExpression | string
}

export interface IAction2Keybinding {
  /**
   * Platform-neutral key string for a single stroke (e.g. "ctrl+b"),
   * or a 2-element tuple for a chord (e.g. ["ctrl+k", "ctrl+s"]).
   */
  primary: string | readonly [string, string]
  when?: ContextKeyExpression | string
  /** Optional argument forwarded to the command handler when the binding fires. */
  args?: unknown
}

export interface IAction2Options {
  /** Unique command id. */
  id: string
  /** Title for menus / command palette. */
  title: string | ICommandActionTitle
  /** Optional category prefix shown in the command palette. */
  category?: string
  /** Optional icon identifier. */
  icon?: string
  /**
   * Optional precondition. When set, it is ANDed onto every menu and
   * keybinding when-clause registered by this action.
   */
  precondition?: ContextKeyExpression | string
  /** Menu placement(s). */
  menu?: IAction2Menu | readonly IAction2Menu[]
  /** Keybinding(s). */
  keybinding?: IAction2Keybinding | readonly IAction2Keybinding[]
  /**
   * When true, the action is also surfaced in the command palette
   * (MenuId.CommandPalette).
   */
  f1?: boolean
}

export abstract class Action2 {
  constructor(readonly desc: Readonly<IAction2Options>) {}
  abstract run(accessor: ServicesAccessor, ...args: unknown[]): unknown
}

function toExpr(when: ContextKeyExpression | string | undefined): ContextKeyExpression | undefined {
  if (when === undefined) return undefined
  if (typeof when === 'string') return ContextKeyExpr.deserialize(when)
  return when
}

function combineWhen(
  a: ContextKeyExpression | string | undefined,
  b: ContextKeyExpression | string | undefined,
): ContextKeyExpression | undefined {
  const exprA = toExpr(a)
  const exprB = toExpr(b)
  if (exprA && exprB) return ContextKeyExpr.and(exprA, exprB)
  return exprA ?? exprB
}

function titleString(title: string | ICommandActionTitle): string {
  return typeof title === 'string' ? title : title.value
}

function asArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? (value as readonly T[]) : [value as T]
}

/**
 * Instantiate the action and register its command, menus, and keybindings.
 * Returns a single disposable that unregisters everything.
 */
export function registerAction2(ctor: new () => Action2): IDisposable {
  const action = new ctor()
  const desc = action.desc
  const disposables: IDisposable[] = []

  const metadata: ICommandMetadata = {}
  metadata.description = titleString(desc.title)
  if (desc.category !== undefined) {
    metadata.category = desc.category
  }

  disposables.push(
    CommandsRegistry.registerCommand({
      id: desc.id,
      handler: (accessor, ...args) => action.run(accessor, ...args),
      metadata,
    }),
  )

  const menus: IAction2Menu[] = [...asArray(desc.menu)]
  if (desc.f1) {
    menus.push(
      desc.precondition !== undefined
        ? { id: MenuId.CommandPalette, when: desc.precondition }
        : { id: MenuId.CommandPalette },
    )
  }
  for (const menu of menus) {
    const when = combineWhen(desc.precondition, menu.when)
    const item: IMenuItem = {
      command: desc.id,
      ...(when !== undefined ? { when } : {}),
      ...(menu.group !== undefined ? { group: menu.group } : {}),
      ...(menu.order !== undefined ? { order: menu.order } : {}),
      title: titleString(desc.title),
      ...(desc.icon !== undefined ? { icon: desc.icon } : {}),
    }
    disposables.push(MenuRegistry.addMenuItem(menu.id, item))
  }

  for (const kb of asArray(desc.keybinding)) {
    const when = combineWhen(desc.precondition, kb.when)
    const item: IKeybindingItem = {
      ...(typeof kb.primary === 'string' ? { key: kb.primary } : { chords: kb.primary }),
      command: desc.id,
      ...(when !== undefined ? { when } : {}),
      ...(kb.args !== undefined ? { args: kb.args } : {}),
    }
    disposables.push(KeybindingsRegistry.registerKeybinding(item))
  }

  return markAsSingleton(combinedDisposable(...disposables))
}
