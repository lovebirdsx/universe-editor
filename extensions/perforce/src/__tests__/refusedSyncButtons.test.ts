import { describe, expect, it, vi } from 'vitest'

// extension.ts pulls in the whole extension surface at import time; stub the API
// so importing the pure `refusedSyncButtons` helper doesn't require the real host.
vi.mock('@universe-editor/extension-api', () => ({
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  workspace: { getConfiguration: vi.fn(), rootPath: undefined },
  window: {},
}))

import { refusedSyncButtons, type RefusedSyncButton } from '../extension.js'

describe('refusedSyncButtons', () => {
  const cases: Array<{
    name: string
    state: {
      refusedModified: number
      refusedOverwrite: number
      mustResolve: number
      allowForce: boolean
    }
    expected: RefusedSyncButton[]
  }> = [
    {
      name: 'refused files with force allowed',
      state: { refusedModified: 1, refusedOverwrite: 0, mustResolve: 0, allowForce: true },
      expected: ['collect', 'diff', 'force'],
    },
    {
      name: 'refused files without force',
      state: { refusedModified: 1, refusedOverwrite: 0, mustResolve: 0, allowForce: false },
      expected: ['collect', 'diff'],
    },
    {
      name: 'only files needing resolve',
      state: { refusedModified: 0, refusedOverwrite: 0, mustResolve: 1, allowForce: false },
      expected: ['resolve'],
    },
    {
      name: 'both kinds with force allowed',
      state: { refusedModified: 1, refusedOverwrite: 0, mustResolve: 1, allowForce: true },
      expected: ['collect', 'diff', 'force', 'resolve'],
    },
    {
      name: 'both kinds without force',
      state: { refusedModified: 1, refusedOverwrite: 0, mustResolve: 1, allowForce: false },
      expected: ['collect', 'diff', 'resolve'],
    },
    {
      name: 'untracked orphans with force allowed — collect/diff make no sense, only force',
      state: { refusedModified: 0, refusedOverwrite: 2, mustResolve: 0, allowForce: true },
      expected: ['force'],
    },
    {
      name: 'untracked orphans without force — nothing offered',
      state: { refusedModified: 0, refusedOverwrite: 2, mustResolve: 0, allowForce: false },
      expected: [],
    },
    {
      name: 'modified files win over orphans — orphan remedy rides the modified set',
      state: { refusedModified: 1, refusedOverwrite: 1, mustResolve: 0, allowForce: true },
      expected: ['collect', 'diff', 'force'],
    },
    {
      name: 'orphans plus files needing resolve',
      state: { refusedModified: 0, refusedOverwrite: 1, mustResolve: 1, allowForce: true },
      expected: ['force', 'resolve'],
    },
    {
      name: 'no refusals and nothing to resolve',
      state: { refusedModified: 0, refusedOverwrite: 0, mustResolve: 0, allowForce: false },
      expected: [],
    },
  ]

  it.each(cases)('$name', ({ state, expected }) => {
    expect(refusedSyncButtons(state)).toEqual(expected)
  })
})
