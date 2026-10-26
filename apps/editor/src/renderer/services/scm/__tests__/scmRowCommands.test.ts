import { describe, expect, it } from 'vitest'
import {
  SCM_HOVER_LEADING_COMMANDS,
  SCM_OPEN_FILE_COMMAND,
  SCM_OPEN_PREVIEW_COMMAND,
  SCM_TARGETED_OPEN_COMMANDS,
  scmTargetedOpenArgs,
} from '../scmRowCommands.js'

describe('scmRowCommands', () => {
  it('whitelists the SCM-row open commands that accept an openTarget option', () => {
    for (const id of [
      'git.openChange',
      'git.openMergeEditor',
      'perforce.openChange',
      'perforce.openMergeEditor',
      'perforce.openShelvedFile',
    ]) {
      expect(SCM_TARGETED_OPEN_COMMANDS.has(id)).toBe(true)
    }
  })

  it('does not derive the whitelist from the 1_open group', () => {
    // Shares `1_open` with the open commands but its handler takes no options;
    // passing a trailing { openTarget } would be meaningless.
    expect(SCM_TARGETED_OPEN_COMMANDS.has('perforce-graph.viewFileHistory')).toBe(false)
    // Host-owned actions read the ambient modifiers instead.
    expect(SCM_TARGETED_OPEN_COMMANDS.has(SCM_OPEN_FILE_COMMAND)).toBe(false)
    expect(SCM_TARGETED_OPEN_COMMANDS.has(SCM_OPEN_PREVIEW_COMMAND)).toBe(false)
  })

  it('keeps the hover strip leading with the host open actions', () => {
    expect(SCM_HOVER_LEADING_COMMANDS).toEqual([SCM_OPEN_PREVIEW_COMMAND, SCM_OPEN_FILE_COMMAND])
  })

  describe('scmTargetedOpenArgs', () => {
    const primary = { resourceUri: '/repo/a.ts', scmResourceGroupId: 'changes' }

    it('prefers the shelved row payload and appends the target last', () => {
      // Shelved rows address a changelist + depot path, not the resource DTO.
      const explicit = [
        {
          changelist: '1234',
          depotFile: '//depot/branch_x/a.ts',
          rev: '3',
          action: 'edit',
        },
      ]

      const args = scmTargetedOpenArgs(explicit, primary, 'side')

      expect(args).toEqual([...explicit, { openTarget: 'side' }])
    })

    it('falls back to the clicked row when the command carries no arguments', () => {
      expect(scmTargetedOpenArgs(undefined, primary, 'newWindow')).toEqual([
        primary,
        { openTarget: 'newWindow' },
      ])
      expect(scmTargetedOpenArgs([], primary, 'side')).toEqual([primary, { openTarget: 'side' }])
    })

    it('keeps a default-target invocation free of an options bag', () => {
      expect(scmTargetedOpenArgs(undefined, primary, 'default')).toEqual([primary])
    })
  })
})
