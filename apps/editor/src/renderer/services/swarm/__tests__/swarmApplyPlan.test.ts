/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import type {
  SwarmReviewDetailDto,
  SwarmReviewFileDto,
  SwarmVersionDto,
} from '@universe-editor/extensions-common'
import { normalizeSwarmStream, planApplyToLocal, resolveReviewStream } from '../swarmApplyPlan.js'

function file(overrides: Partial<SwarmReviewFileDto> = {}): SwarmReviewFileDto {
  return {
    status: overrides.status ?? 'M',
    path: overrides.path ?? 'depot/src/a.ts',
    depotFile: overrides.depotFile ?? '//depot/src/a.ts',
    localPath: overrides.localPath === undefined ? 'C:/ws/src/a.ts' : overrides.localPath,
    baseRevision: overrides.baseRevision ?? '3',
  }
}

function version(idx: number, stream?: string): SwarmVersionDto {
  return {
    version: idx + 1,
    change: String(2001 + idx),
    pending: true,
    time: idx,
    ...(stream !== undefined ? { stream } : {}),
  }
}

function detail(stream: string | undefined, streams: (string | undefined)[]) {
  return {
    ...(stream !== undefined ? { stream } : {}),
    versions: streams.map((s, i) => version(i, s)),
  } as Pick<SwarmReviewDetailDto, 'stream' | 'versions'>
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
    expect(plan.mappedFiles.map((f) => f.depotFile)).toEqual(['//depot/src/a.ts'])
    expect(plan.unmappedFiles.map((f) => f.depotFile)).toEqual(['//unmapped/b.ts'])
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

  it('builds forceFiles as mapped-in-scope + unmapped in the original order', () => {
    const plan = planApplyToLocal(
      [
        file({ depotFile: '//depot/streams/dev/a.ts', localPath: 'C:/ws/a.ts' }),
        file({
          depotFile: '//depot/streams/review/b.ts',
          path: 'streams/review/b.ts',
          localPath: null,
        }),
        file({
          depotFile: '//other/c.ts',
          path: 'other/c.ts',
          localPath: 'D:/other/c.ts',
        }),
        file({
          depotFile: '//depot/streams/review/d.ts',
          path: 'streams/review/d.ts',
          localPath: null,
        }),
      ],
      false,
      inWs,
    )
    expect(plan.forceFiles.map((f) => f.depotFile)).toEqual([
      '//depot/streams/dev/a.ts',
      '//depot/streams/review/b.ts',
      '//depot/streams/review/d.ts',
    ])
    expect(plan.mappedFiles.map((f) => f.depotFile)).toEqual(['//depot/streams/dev/a.ts'])
    expect(plan.unmappedFiles.map((f) => f.depotFile)).toEqual([
      '//depot/streams/review/b.ts',
      '//depot/streams/review/d.ts',
    ])
  })

  it('keeps the status on force files so deletions can be classified host-side', () => {
    const plan = planApplyToLocal(
      [
        file({
          status: 'A',
          depotFile: '//depot/streams/review/new.ts',
          path: 'streams/review/new.ts',
          localPath: null,
        }),
      ],
      false,
      inWs,
    )
    expect(plan.forceFiles).toEqual([
      expect.objectContaining({ depotFile: '//depot/streams/review/new.ts', status: 'A' }),
    ])
  })
})

describe('normalizeSwarmStream', () => {
  it('accepts both wire forms and normalizes to //depot', () => {
    expect(normalizeSwarmStream('depot/branch_x')).toBe('//depot/branch_x')
    expect(normalizeSwarmStream('//depot/branch_x')).toBe('//depot/branch_x')
    expect(normalizeSwarmStream('  //depot/branch_x/  ')).toBe('//depot/branch_x')
  })

  it('returns undefined for empty input', () => {
    expect(normalizeSwarmStream(undefined)).toBeUndefined()
    expect(normalizeSwarmStream('')).toBeUndefined()
    expect(normalizeSwarmStream('   ')).toBeUndefined()
    expect(normalizeSwarmStream('//')).toBeUndefined()
  })

  it('rejects specs the host would refuse (wildcards, revisions, empty segments)', () => {
    expect(normalizeSwarmStream('//depot/branch@1')).toBeUndefined()
    expect(normalizeSwarmStream('//depot/branch#2')).toBeUndefined()
    expect(normalizeSwarmStream('//depot/br%anch')).toBeUndefined()
    expect(normalizeSwarmStream('//depot/br*anch')).toBeUndefined()
    expect(normalizeSwarmStream('//depot//branch_x')).toBeUndefined()
    expect(normalizeSwarmStream('//depot/./branch_x')).toBeUndefined()
    expect(normalizeSwarmStream('//depot/../branch_x')).toBeUndefined()
    expect(normalizeSwarmStream('//depot/...')).toBeUndefined()
  })
})

describe('resolveReviewStream', () => {
  it('prefers the selected version stream', () => {
    expect(resolveReviewStream(detail('depot/latest', ['depot/v1', 'depot/v2']), 0)).toBe(
      '//depot/v1',
    )
  })

  it('falls back to detail.stream only when no version carries a stream', () => {
    expect(resolveReviewStream(detail('depot/latest', [undefined, undefined]), 0)).toBe(
      '//depot/latest',
    )
  })

  it('does not borrow another version stream for a stream-less selected version', () => {
    expect(resolveReviewStream(detail('depot/latest', [undefined, 'depot/v2']), 0)).toBeUndefined()
  })

  it('returns undefined without a selected version or detail', () => {
    expect(resolveReviewStream(detail('depot/latest', ['depot/v1']), null)).toBeUndefined()
    expect(resolveReviewStream(detail('depot/latest', ['depot/v1']), 5)).toBeUndefined()
    expect(resolveReviewStream(undefined, 0)).toBeUndefined()
    expect(resolveReviewStream(null, 0)).toBeUndefined()
  })
})
