import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { stagedStates, workingStates } from '../repositoryDecoration.js'
import type { GitFileStatus } from '../statusParser.js'

const tracked = (over: Partial<GitFileStatus>): GitFileStatus => ({
  path: 'a.ts',
  index: '.',
  workingTree: '.',
  kind: 'tracked',
  ...over,
})

describe('repositoryDecoration', () => {
  it('stagedStates picks tracked files with an index change', () => {
    const files = [
      tracked({ path: 'staged.ts', index: 'M', workingTree: '.' }),
      tracked({ path: 'workingonly.ts', index: '.', workingTree: 'M' }),
      { path: 'new.ts', index: '?', workingTree: '?', kind: 'untracked' } as GitFileStatus,
    ]
    const states = stagedStates('/repo', files, true)
    expect(states.map((s) => s.resourceUri)).toEqual([join('/repo', 'staged.ts')])
    expect(states[0]?.contextValue).toBe('M')
  })

  it('workingStates picks any file with a working-tree change', () => {
    const files = [
      tracked({ path: 'staged.ts', index: 'M', workingTree: '.' }),
      tracked({ path: 'dirty.ts', index: '.', workingTree: 'M' }),
    ]
    const states = workingStates('/repo', files, true)
    expect(states.map((s) => s.resourceUri)).toEqual([join('/repo', 'dirty.ts')])
  })

  it('routes a conflicted file to the merge editor only when enabled', () => {
    const files = [tracked({ path: 'conflict.ts', index: 'U', workingTree: 'U' })]
    const withMerge = workingStates('/repo', files, true)
    expect(withMerge[0]?.command?.command).toBe('git.openMergeEditor')

    const withoutMerge = workingStates('/repo', files, false)
    expect(withoutMerge[0]?.command?.command).toBe('git.openChange')
  })

  it('falls back to a neutral decoration for unknown status letters', () => {
    const files = [tracked({ path: 'weird.ts', index: '.', workingTree: 'X' })]
    const states = workingStates('/repo', files, true)
    expect(states[0]?.decorations?.tooltip).toBe('X')
    expect(states[0]?.decorations?.color).toBe('#cccccc')
  })
})
