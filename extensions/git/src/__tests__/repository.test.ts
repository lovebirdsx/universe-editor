import { describe, expect, it } from 'vitest'
import { gitPrimaryInputCommand } from '../repository.js'

describe('gitPrimaryInputCommand', () => {
  it('uses Commit when local changes are present', () => {
    expect(gitPrimaryInputCommand({ hasChanges: true, ahead: 1, behind: 1 })).toEqual({
      command: 'git.commit',
      title: 'Commit',
    })
  })

  it('uses Sync when there are no local changes and the branch is ahead or behind', () => {
    expect(gitPrimaryInputCommand({ hasChanges: false, ahead: 1, behind: 0 })).toEqual({
      command: 'git.sync',
      title: 'Sync',
    })
    expect(gitPrimaryInputCommand({ hasChanges: false, ahead: 0, behind: 1 })).toEqual({
      command: 'git.sync',
      title: 'Sync',
    })
  })

  it('uses Commit when there is nothing to synchronize', () => {
    expect(gitPrimaryInputCommand({ hasChanges: false, ahead: 0, behind: 0 })).toEqual({
      command: 'git.commit',
      title: 'Commit',
    })
  })
})
