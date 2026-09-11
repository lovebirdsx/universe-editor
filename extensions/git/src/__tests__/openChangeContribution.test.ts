import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * `git.openChange` is a provider capability command, not a user-facing entry:
 * the workbench's `workbench.action.scm.openChanges` is the single Open Changes
 * command and arbitrates between git and Perforce. Re-declaring a title-bar or
 * Explorer entry here is what used to put two identical compare icons in the
 * title bar of a file tracked by both, so the manifest is asserted rather than
 * reviewed.
 *
 * The SCM row's context menu is the one place it does belong: those rows pass
 * the provider its own `{ resourceUri }` argument shape, which the unified
 * command deliberately does not accept.
 */

interface MenuItem {
  command?: string
  when?: string
}

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as {
  contributes: { commands: { command: string }[]; menus: Record<string, MenuItem[] | undefined> }
}

const menu = (id: string): MenuItem[] => manifest.contributes.menus[id] ?? []

describe('git.openChange contribution', () => {
  it('contributes no editor-title or explorer entry of its own', () => {
    for (const id of ['editor/title', 'explorer/context']) {
      expect(menu(id).map((item) => item.command)).not.toContain('git.openChange')
    }
  })

  it('opts out of the command palette', () => {
    expect(menu('commandPalette')).toContainEqual({ command: 'git.openChange', when: 'false' })
  })

  it('stays declared so SCM rows and the unified command can invoke it', () => {
    expect(manifest.contributes.commands.map((c) => c.command)).toContain('git.openChange')
  })

  it('reaches SCM rows through their context menu', () => {
    expect(menu('scm/resourceState/context').map((item) => item.command)).toContain(
      'git.openChange',
    )
  })
})
