import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * Outside a Git repository every contributed command is dead: `activate()` only
 * registers a handful of stubs, so the host answers "Contributed command 'x'
 * does not exist." A declared-but-unregistered command is exactly the case a
 * `when` clause is for, so every command carries an explicit palette entry —
 * either the repository gate or a plain `false` (commands that need an argument
 * or context and must never appear in a palette). The whole set is asserted at
 * once because a new command added without one silently reopens the hole: it
 * lands in the palette of every window, repository or not.
 */

interface CommandContribution {
  command: string
}

interface PaletteEntry {
  command?: string
  when?: string
}

interface KeybindingContribution {
  command: string
  key: string
  when?: string
}

interface Manifest {
  contributes: {
    commands?: CommandContribution[]
    menus?: { commandPalette?: PaletteEntry[] }
    keybindings?: KeybindingContribution[]
  }
}

/** The context key `activate()` paints: true only once a repository is surfaced. */
const PALETTE_GATE = 'gitHasRepository'
/** Hidden outright — these need arguments/context, not merely a repository. */
const ALWAYS_HIDDEN = 'false'

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as Manifest

describe('contributes.menus.commandPalette', () => {
  it('gates every contributed command on the repository context key', () => {
    const entries = manifest.contributes.menus?.commandPalette ?? []
    const byCommand = new Map(entries.map((e) => [e.command, e.when]))
    const commands = manifest.contributes.commands ?? []

    for (const { command } of commands) {
      const when = byCommand.get(command)
      expect(`${command}: ${when}`).toMatch(
        new RegExp(`^${command}: (${PALETTE_GATE}|${ALWAYS_HIDDEN})$`),
      )
    }
    // No entry without a command, none for a command the manifest dropped, and
    // none twice (the Map above would collapse a duplicate before the key
    // comparison could see it).
    expect(entries.length).toBe(commands.length)
    expect([...byCommand.keys()].sort()).toEqual(commands.map((c) => c.command).sort())
  })

  it('hides the commands that need an argument or context in every window', () => {
    const entries = manifest.contributes.menus?.commandPalette ?? []

    expect(
      entries
        .filter((e) => e.when === ALWAYS_HIDDEN)
        .map((e) => e.command)
        .sort(),
    ).toEqual([
      'git.agentDelivery.abortPick',
      'git.agentDelivery.acquireLock',
      'git.agentDelivery.begin',
      'git.agentDelivery.changeContext',
      'git.agentDelivery.commitSource',
      'git.agentDelivery.continuePick',
      'git.agentDelivery.hasPendingWork',
      'git.agentDelivery.heartbeatLock',
      'git.agentDelivery.inspect',
      'git.agentDelivery.inspectPushBranch',
      'git.agentDelivery.preparePick',
      'git.agentDelivery.promoteAndPush',
      'git.agentDelivery.pushBranch',
      'git.agentDelivery.releaseLock',
      'git.agentDelivery.restoreMain',
      'git.agentDelivery.syncWorktrees',
      'git.agentDelivery.undo',
      'git.openChange',
      'git.timeline.viewCommit',
      'git.viewCommit',
    ])
  })
})

describe('contributes.keybindings', () => {
  it('gates every contributed keybinding on the same context key', () => {
    for (const kb of manifest.contributes.keybindings ?? []) {
      expect([PALETTE_GATE, ALWAYS_HIDDEN]).toContain(kb.when)
    }

    expect(
      (manifest.contributes.keybindings ?? []).find((kb) => kb.command === 'git.refresh')?.when,
    ).toBe(PALETTE_GATE)
  })
})
