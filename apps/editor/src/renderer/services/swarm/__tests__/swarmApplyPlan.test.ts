/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import type { SwarmReviewFileDto } from '@universe-editor/extensions-common'
import { planApplyToLocal } from '../swarmApplyPlan.js'

function file(overrides: Partial<SwarmReviewFileDto> = {}): SwarmReviewFileDto {
  return {
    status: 'M',
    path: overrides.path ?? 'depot/src/a.ts',
    depotFile: overrides.depotFile ?? '//depot/src/a.ts',
    localPath: overrides.localPath === undefined ? 'C:/ws/src/a.ts' : overrides.localPath,
    baseRevision: overrides.baseRevision ?? '3',
  }
}

const inWs = (fsPath: string) => fsPath.startsWith('C:/ws/')

describe('planApplyToLocal', () => {
  it('sends every mapped in-workspace file, listing unmapped ones separately', () => {
    const plan = planApplyToLocal(
      [
        file({ depotFile: '//depot/src/a.ts', localPath: 'C:/ws/src/a.ts' }),
        file({ depotFile: '//unmapped/b.ts', path: 'unmapped/b.ts', localPath: null }),
      ],
      false,
      inWs,
    )
    expect(plan.depotFiles).toEqual(['//depot/src/a.ts'])
    expect(plan.outsidePaths).toEqual([])
    expect(plan.unmappedPaths).toEqual(['unmapped/b.ts'])
  })

  it('skips mapped-but-outside files when the toggle is off', () => {
    const plan = planApplyToLocal(
      [
        file({ depotFile: '//depot/src/a.ts', localPath: 'C:/ws/src/a.ts' }),
        file({
          depotFile: '//other/c.ts',
          path: 'other/c.ts',
          localPath: 'D:/other/c.ts',
        }),
      ],
      false,
      inWs,
    )
    expect(plan.depotFiles).toEqual(['//depot/src/a.ts'])
    expect(plan.outsidePaths).toEqual(['other/c.ts'])
    expect(plan.unmappedPaths).toEqual([])
  })

  it('includes outside files when the toggle is on', () => {
    const plan = planApplyToLocal(
      [
        file({
          depotFile: '//other/c.ts',
          path: 'other/c.ts',
          localPath: 'D:/other/c.ts',
        }),
      ],
      true,
      inWs,
    )
    expect(plan.depotFiles).toEqual(['//other/c.ts'])
    expect(plan.outsidePaths).toEqual([])
  })

  it('treats everything as outside when no workspace is open', () => {
    const plan = planApplyToLocal([file()], false, () => false)
    expect(plan.depotFiles).toEqual([])
    expect(plan.outsidePaths).toEqual(['depot/src/a.ts'])
  })

  it('still lists unmapped paths when the toggle is on (p4 cannot restore them)', () => {
    const plan = planApplyToLocal(
      [file({ depotFile: '//unmapped/b.ts', path: 'unmapped/b.ts', localPath: null })],
      true,
      inWs,
    )
    expect(plan.depotFiles).toEqual([])
    expect(plan.outsidePaths).toEqual([])
    expect(plan.unmappedPaths).toEqual(['unmapped/b.ts'])
  })
})
