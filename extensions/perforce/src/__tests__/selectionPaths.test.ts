import { describe, expect, it, vi } from 'vitest'

// extension.ts pulls in the whole extension surface at import time; stub the API
// so importing the pure `selectionPaths` helper doesn't require the real host.
vi.mock('@universe-editor/extension-api', () => ({
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  workspace: { getConfiguration: vi.fn(), rootPath: undefined },
  window: {},
}))

import { selectionPaths } from '../extension.js'

describe('selectionPaths', () => {
  it('extracts resource paths from a multi-selection array', () => {
    expect(
      selectionPaths([
        { resourceUri: 'D:/w/a.txt', scmResourceGroupId: 'default' },
        { resourceUri: 'D:/w/b.txt', scmResourceGroupId: 'default' },
      ]),
    ).toEqual(['D:/w/a.txt', 'D:/w/b.txt'])
  })

  it('drops entries without a resourceUri', () => {
    expect(
      selectionPaths([{ resourceUri: 'D:/w/a.txt' }, { scmResourceGroupId: 'cl:5' }, {}]),
    ).toEqual(['D:/w/a.txt'])
  })

  it('returns [] for a non-array or empty selection', () => {
    expect(selectionPaths(undefined)).toEqual([])
    expect(selectionPaths([])).toEqual([])
    expect(selectionPaths({ resourceUri: 'D:/w/a.txt' })).toEqual([])
  })
})
