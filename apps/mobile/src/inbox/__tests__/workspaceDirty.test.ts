import type { MobileWorkspaceCandidate } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { collectDirtyWindowIds } from '../workspaceDirty.js'

function workspace(overrides: Partial<MobileWorkspaceCandidate>): MobileWorkspaceCandidate {
  return { folder: 'file:///repo', name: 'repo', isOpen: true, ...overrides }
}

describe('collectDirtyWindowIds', () => {
  it('collects only dirty candidates that belong to an open window', () => {
    const ids = collectDirtyWindowIds([
      workspace({ folder: 'file:///a', windowId: 1, gitDirty: true }),
      workspace({ folder: 'file:///b', windowId: 2, gitDirty: false }),
      workspace({ folder: 'file:///c', windowId: 3 }),
      workspace({ folder: 'file:///d', gitDirty: true }),
    ])
    expect([...ids]).toEqual([1])
  })

  it('returns an empty set when nothing is dirty', () => {
    expect(
      collectDirtyWindowIds([workspace({ folder: 'file:///a', windowId: 1, gitDirty: false })]),
    ).toEqual(new Set())
  })
})
