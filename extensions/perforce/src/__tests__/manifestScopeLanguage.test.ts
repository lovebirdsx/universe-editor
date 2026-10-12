import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { SCOPE_FILE_NAME } from '../scopeConfig.js'

/*
 * `.p4delta-scope` is strict JSON but carries no `.json` suffix, so its
 * language association lives in the manifest by filename. The two spellings
 * are asserted together rather than reviewed: a rename on either side would
 * silently drop syntax highlighting and the JSON file icon for the one file
 * users are told to hand-edit, and nothing else would fail.
 */

interface LanguageContribution {
  id?: string
  filenames?: string[]
}

interface CommandContribution {
  command: string
}

interface PaletteEntry {
  command?: string
  when?: string
}

interface Manifest {
  contributes: {
    languages?: LanguageContribution[]
    commands?: CommandContribution[]
    menus?: { commandPalette?: PaletteEntry[] }
  }
}

/** The context key `activate()` paints: true only once a p4 client is in hand. */
const PALETTE_GATE = 'perforceHasWorkspace'
/** Hidden outright — these need arguments/context, not merely a workspace. */
const ALWAYS_HIDDEN = 'false'

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as Manifest

describe('contributes.languages', () => {
  it('associates the scope file with JSON by filename', () => {
    expect(manifest.contributes.languages).toContainEqual({
      id: 'json',
      filenames: [SCOPE_FILE_NAME],
    })
  })
})

/*
 * Outside a Perforce workspace every contributed command is dead: `activate()`
 * bails before its registration burst, so the host answers "Contributed command
 * 'x' does not exist." A declared-but-unregistered command is exactly the case a
 * `when` clause is for, so every command carries an explicit palette entry —
 * either the workspace gate or a plain `false`. The whole set is asserted at
 * once because a new command added without one silently reopens the hole (it
 * lands in the palette of every window, Perforce workspace or not).
 */
describe('contributes.menus.commandPalette', () => {
  it('gates every contributed command on the workspace context key', () => {
    const entries = manifest.contributes.menus?.commandPalette ?? []
    const byCommand = new Map(entries.map((e) => [e.command, e.when]))

    for (const { command } of manifest.contributes.commands ?? []) {
      const when = byCommand.get(command)
      expect(`${command}: ${when}`).toMatch(
        new RegExp(`^${command}: (${PALETTE_GATE}|${ALWAYS_HIDDEN})$`),
      )
    }
    // No entry without a command, none for a command the manifest dropped, and
    // none twice (the Map above would collapse a duplicate before the key
    // comparison could see it).
    expect(entries.length).toBe((manifest.contributes.commands ?? []).length)
    expect([...byCommand.keys()].sort()).toEqual(
      (manifest.contributes.commands ?? []).map((c) => c.command).sort(),
    )
  })

  it('keeps the needs-an-argument commands hidden everywhere', () => {
    const entries = manifest.contributes.menus?.commandPalette ?? []
    const alwaysHidden = entries.filter((e) => e.when === ALWAYS_HIDDEN).map((e) => e.command)

    expect(alwaysHidden.sort()).toEqual([
      'perforce.openChange',
      'perforce.timeline.getThisRevision',
      'perforce.timeline.viewCommit',
      'perforce.viewCommit',
    ])
  })
})
