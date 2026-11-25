/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Guards the icon-id → glyph tables against drift.
 *
 * `icon` ids travel as opaque strings and are resolved at render time; an
 * unknown id renders nothing and reports no error, so a typo is invisible until
 * someone notices a blank slot in a menu. These tests turn that silence back
 * into a failure:
 *
 * 1. Every `icon: '<id>'` literal in renderer source resolves — through the
 *    workbench resolver (curated Lucide table + codicon font fallback) or the
 *    agent-logo table that `renderMenuIcon` chains in.
 * 2. Every extension manifest's `contributes.menus[].icon` / `submenus[].icon` /
 *    `commands[].icon` resolves. Command icons count because a menu item without
 *    its own icon inherits the one its command declared
 *    (`ExtensionPointTranslator._registerMenus`).
 * 3. Menubar menus stay icon-free. `registerAction2` spreads `desc.icon` into
 *    every menu slot an Action2 declares, so a well-meant icon on a command that
 *    also sits in the File/Edit/View menu would silently turn on the whole
 *    menu's icon column. Asserting on the registry catches that propagation,
 *    which scanning source cannot.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codiconLibrary, MenuId, MenuRegistry } from '@universe-editor/platform'
import { isKnownAgentIcon } from '../../agents/agentIcon.js'
import { isKnownCodicon, isKnownIcon } from '../icon-map.js'
import { parseIconReference } from '../iconReference.js'
import { EditMenuContribution } from '../../../contributions/EditMenuContribution.js'
// Side-effect import: registers every Action2, which is what fans `desc.icon`
// out into the menu slots this file asserts on.
import '../../../actions/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(here, '..', '..', '..')
const repoRoot = join(rendererRoot, '..', '..', '..', '..')
const manifestRoots = [join(repoRoot, 'extensions'), join(repoRoot, 'extensions-external')]
const e2eSpecsRoot = join(repoRoot, 'apps', 'editor', 'e2e', 'specs')

/**
 * An id is covered when it is a curated Lucide id, an agent logo, or a real
 * codicon (`$(id)` and `~modifier` are normalized first). Codicon ids count
 * because `resolveIcon` renders them from the font.
 */
function resolves(rawId: string): boolean {
  const reference = parseIconReference(rawId)
  if (reference === undefined) return false
  if (reference.modifier === undefined && isKnownIcon(reference.id)) return true
  if (reference.modifier === undefined && isKnownAgentIcon(reference.id)) return true
  return isKnownCodicon(reference.id)
}

function* walk(dir: string, ext: readonly string[]): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'out') continue
      yield* walk(path, ext)
    } else if (ext.some((e) => name.endsWith(e))) {
      yield path
    }
  }
}

describe('icon coverage', () => {
  it('resolves every icon id used in renderer source', () => {
    const unknown: string[] = []
    for (const file of walk(rendererRoot, ['.ts', '.tsx'])) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bicon:\s*(?:'([^']+)'|"([^"]+)")/g)) {
        const id = m[1] ?? m[2]
        if (id !== undefined && !resolves(id)) {
          unknown.push(`${relative(repoRoot, file)}: '${id}'`)
        }
      }
    }
    expect(unknown).toEqual([])
  })

  it('resolves every icon id declared by an extension manifest', () => {
    const unknown: string[] = []
    for (const root of manifestRoots) {
      let names: string[]
      try {
        names = readdirSync(root)
      } catch {
        continue
      }
      for (const name of names) {
        const manifestPath = join(root, name, 'package.json')
        let raw: string
        try {
          raw = readFileSync(manifestPath, 'utf8')
        } catch {
          continue
        }
        const contributes = (JSON.parse(raw) as ExtensionManifest).contributes
        if (!contributes) continue
        const check = (id: unknown, where: string): void => {
          if (typeof id === 'string' && !resolves(id)) unknown.push(`${name} ${where}: '${id}'`)
        }
        for (const [menuId, items] of Object.entries(contributes.menus ?? {})) {
          for (const item of items) check(item.icon, `menus.${menuId}`)
        }
        for (const submenu of contributes.submenus ?? []) check(submenu.icon, 'submenus')
        // Inherited by any menu placement of the command that omits its own icon.
        for (const command of contributes.commands ?? []) check(command.icon, 'commands')
        for (const container of contributes.viewsContainers?.activitybar ?? []) {
          check(container.icon, 'viewsContainers.activitybar')
        }
        for (const [containerId, views] of Object.entries(contributes.views ?? {})) {
          for (const view of views) check(view.icon, `views.${containerId}`)
        }
        for (const view of contributes.trustedViews ?? []) check(view.icon, 'trustedViews')
      }
    }
    expect(unknown).toEqual([])
  })

  it('resolves every icon id used in e2e fixtures', () => {
    const unknown: string[] = []
    for (const file of walk(e2eSpecsRoot, ['.ts'])) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bicon:\s*(?:'([^']+)'|"([^"]+)")/g)) {
        const id = m[1] ?? m[2]
        if (id !== undefined && !resolves(id)) {
          unknown.push(`e2e/${relative(e2eSpecsRoot, file)}: '${id}'`)
        }
      }
    }
    expect(unknown).toEqual([])
  })

  it('keeps codiconLibrary in sync with the installed codicon.css', () => {
    const require = createRequire(import.meta.url)
    const css = readFileSync(require.resolve('@vscode/codicons/dist/codicon.css'), 'utf8')
    const ids = new Set(
      [...css.matchAll(/\.codicon-([a-zA-Z0-9-]+)(?=::?before|,|\s*\{)/g)]
        .map((m) => m[1])
        .filter((id): id is string => id !== undefined && !id.startsWith('modifier-')),
    )
    expect(ids).toEqual(new Set(Object.keys(codiconLibrary)))
  })

  it('keeps the menubar menus icon-free', () => {
    // File/View/Help/LayoutControl are filled by Action2s (imported above); the
    // Edit menu is the one that comes from a contribution, so instantiate it —
    // without this the assertion below would pass over an empty menu.
    const editMenu = new EditMenuContribution()
    const menubarMenus = [
      MenuId.MenubarFileMenu,
      MenuId.MenubarEditMenu,
      MenuId.MenubarViewMenu,
      MenuId.MenubarHelpMenu,
      MenuId.LayoutControlMenu,
    ]
    const withIcon: string[] = []
    for (const menuId of menubarMenus) {
      const entries = MenuRegistry.getMenuItems(menuId)
      expect(
        entries.length,
        `${menuId} registered nothing — the assertion below would be vacuous`,
      ).toBeGreaterThan(0)
      for (const entry of entries) {
        if (entry.icon !== undefined) {
          const label = 'command' in entry ? entry.command : entry.submenu
          withIcon.push(`${menuId}: ${label} → '${entry.icon}'`)
        }
      }
    }
    editMenu.dispose()
    expect(withIcon).toEqual([])
  })
})

interface ExtensionManifest {
  readonly contributes?: {
    readonly menus?: Record<string, readonly { readonly icon?: string }[]>
    readonly submenus?: readonly { readonly icon?: string }[]
    readonly commands?: readonly { readonly icon?: string }[]
    readonly viewsContainers?: {
      readonly activitybar?: readonly { readonly icon?: string }[]
    }
    readonly views?: Record<string, readonly { readonly icon?: string }[]>
    readonly trustedViews?: readonly { readonly icon?: string }[]
  }
}
