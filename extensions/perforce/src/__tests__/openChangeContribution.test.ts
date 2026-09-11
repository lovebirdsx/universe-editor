import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * `perforce.openChange` is a provider capability command, not a user-facing
 * entry: the workbench's `workbench.action.scm.openChanges` is the single Open
 * Changes command and arbitrates between git and Perforce. Re-declaring a UI
 * entry here is what used to put two identical compare icons in the title bar
 * of a file tracked by both, so the manifest is asserted rather than reviewed.
 */

interface MenuItem {
  command?: string
  when?: string
  group?: string
}

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as { contributes: { menus: Record<string, MenuItem[] | undefined> } }

const menu = (id: string): MenuItem[] => manifest.contributes.menus[id] ?? []

describe('perforce.openChange contribution', () => {
  it('contributes no editor-title or explorer entry of its own', () => {
    for (const id of ['editor/title', 'explorer/context']) {
      expect(menu(id).map((item) => item.command)).not.toContain('perforce.openChange')
    }
  })

  it('opts out of the command palette', () => {
    expect(menu('commandPalette')).toContainEqual({
      command: 'perforce.openChange',
      when: 'false',
    })
  })

  it('stays available as an SCM row command', () => {
    expect(menu('scm/resourceState/context').map((item) => item.command)).toContain(
      'perforce.openChange',
    )
  })

  // The host owns Open File / Open Preview for every provider's rows now, so a
  // provider-level entry would render a second, identical "Open File".
  it('leaves Open File to the host', () => {
    expect(menu('scm/resourceState/context').map((item) => item.command)).not.toContain(
      'perforce.openFile',
    )
  })

  it('keeps View File History after the host open entries', () => {
    expect(menu('scm/resourceState/context')).toContainEqual(
      expect.objectContaining({
        command: 'perforce-graph.viewFileHistory',
        group: '1_open@4',
      }),
    )
  })
})
