import { describe, expect, it, vi } from 'vitest'

// extension.ts pulls in the whole extension surface at import time; stub the API
// so importing the pure `refusedSyncButtons` helper doesn't require the real host.
vi.mock('@universe-editor/extension-api', () => ({
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  workspace: { getConfiguration: vi.fn(), rootPath: undefined },
  window: {},
}))

import { refusedForceRows, refusedSyncButtons, type RefusedSyncButton } from '../extension.js'
import { buildForceGetFilespecs } from '../p4Filespec.js'

describe('refusedSyncButtons', () => {
  const cases: Array<{
    name: string
    state: {
      refusedModified: number
      refusedOverwrite: number
      mustResolve: number
      allowForce: boolean
      forceTargets: number
    }
    expected: RefusedSyncButton[]
  }> = [
    {
      name: 'refused files with force allowed',
      state: {
        refusedModified: 1,
        refusedOverwrite: 0,
        mustResolve: 0,
        allowForce: true,
        forceTargets: 1,
      },
      expected: ['collect', 'diff', 'force'],
    },
    {
      name: 'refused files without force',
      state: {
        refusedModified: 1,
        refusedOverwrite: 0,
        mustResolve: 0,
        allowForce: false,
        forceTargets: 1,
      },
      expected: ['collect', 'diff'],
    },
    {
      name: 'only files needing resolve',
      state: {
        refusedModified: 0,
        refusedOverwrite: 0,
        mustResolve: 1,
        allowForce: false,
        forceTargets: 0,
      },
      expected: ['resolve'],
    },
    {
      name: 'both kinds with force allowed',
      state: {
        refusedModified: 1,
        refusedOverwrite: 0,
        mustResolve: 1,
        allowForce: true,
        forceTargets: 1,
      },
      expected: ['collect', 'diff', 'force', 'resolve'],
    },
    {
      name: 'both kinds without force',
      state: {
        refusedModified: 1,
        refusedOverwrite: 0,
        mustResolve: 1,
        allowForce: false,
        forceTargets: 1,
      },
      expected: ['collect', 'diff', 'resolve'],
    },
    {
      name: 'untracked orphans with force allowed — collect/diff make no sense, only force',
      state: {
        refusedModified: 0,
        refusedOverwrite: 2,
        mustResolve: 0,
        allowForce: true,
        forceTargets: 2,
      },
      expected: ['force'],
    },
    {
      name: 'untracked orphans without force — nothing offered',
      state: {
        refusedModified: 0,
        refusedOverwrite: 2,
        mustResolve: 0,
        allowForce: false,
        forceTargets: 2,
      },
      expected: [],
    },
    {
      name: 'modified files win over orphans — orphan remedy rides the modified set',
      state: {
        refusedModified: 1,
        refusedOverwrite: 1,
        mustResolve: 0,
        allowForce: true,
        forceTargets: 2,
      },
      expected: ['collect', 'diff', 'force'],
    },
    {
      name: 'orphans plus files needing resolve',
      state: {
        refusedModified: 0,
        refusedOverwrite: 1,
        mustResolve: 1,
        allowForce: true,
        forceTargets: 1,
      },
      expected: ['force', 'resolve'],
    },
    {
      name: 'no refusals and nothing to resolve',
      state: {
        refusedModified: 0,
        refusedOverwrite: 0,
        mustResolve: 0,
        allowForce: false,
        forceTargets: 0,
      },
      expected: [],
    },
  ]

  it.each(cases)('$name', ({ state, expected }) => {
    expect(refusedSyncButtons(state)).toEqual(expected)
  })

  // 全是 delete 拒绝（目标修订删掉了文件、本地仍有未收集改动）时，refusedForceRows
  // 一条可强制的行都产不出，picker 会是空的——按钮不能再出现让它空转。
  it('offers no force button when every refusal is a deletion', () => {
    const deleted = {
      depotFile: '//depot/branch_x/gone.txt',
      clientFile: 'X:/p4ws/main/gone.txt',
      action: 'not deleted',
      rev: '1',
    }
    const forceTargets = refusedForceRows([deleted], []).length
    expect(forceTargets).toBe(0)
    expect(
      refusedSyncButtons({
        refusedModified: 1,
        refusedOverwrite: 0,
        mustResolve: 0,
        allowForce: true,
        forceTargets,
      }),
    ).toEqual(['collect', 'diff'])
  })

  it('still offers force when at least one refusal is forceable', () => {
    const updated = {
      depotFile: '//depot/branch_x/a.json',
      clientFile: 'X:/p4ws/main/a.json',
      action: 'not updated',
      rev: '69',
    }
    const deleted = {
      depotFile: '//depot/branch_x/gone.txt',
      clientFile: 'X:/p4ws/main/gone.txt',
      action: 'not deleted',
      rev: '1',
    }
    expect(
      refusedSyncButtons({
        refusedModified: 2,
        refusedOverwrite: 0,
        mustResolve: 0,
        allowForce: true,
        forceTargets: refusedForceRows([updated, deleted], []).length,
      }),
    ).toEqual(['collect', 'diff', 'force'])
  })
})

describe('refusedForceRows', () => {
  const updated = {
    depotFile: '//depot/branch_x/a.json',
    clientFile: 'X:/p4ws/main/a.json',
    action: 'not updated',
    rev: '69',
  }
  const deleted = {
    depotFile: '//depot/branch_x/gone.txt',
    clientFile: 'X:/p4ws/main/gone.txt',
    action: 'not deleted',
    rev: '1',
  }
  const orphan = {
    depotFile: '//depot/branch_x/b.uasset',
    clientFile: 'X:/p4ws/main/b.uasset',
    action: 'not updated',
    rev: '1',
  }

  it('keeps the modified and orphan rows, each with its own label color', () => {
    const rows = refusedForceRows([updated], [orphan])
    expect(rows.map((r) => [r.depotFile, r.labelColor, r.picked])).toEqual([
      ['//depot/branch_x/a.json', 'modified', true],
      ['//depot/branch_x/b.uasset', 'orphan', true],
    ])
  })

  // delete 拒绝的 `#rev` 是 have 修订，钉住它会把旧修订拉回来、复活 depot 已删的文件，所以
  // 这行绝不能成为逐文件 `-f` 目标。
  it('drops a delete refusal instead of turning its have revision into a target', () => {
    const rows = refusedForceRows([updated, deleted], [])
    expect(rows.map((r) => r.depotFile)).toEqual(['//depot/branch_x/a.json'])
    expect(buildForceGetFilespecs(rows)).toEqual(['//depot/branch_x/a.json#69'])
  })

  it('offers nothing at all when every refusal is a deletion', () => {
    const rows = refusedForceRows([deleted], [])
    expect(rows).toEqual([])
    expect(buildForceGetFilespecs(rows)).toEqual([])
  })
})
