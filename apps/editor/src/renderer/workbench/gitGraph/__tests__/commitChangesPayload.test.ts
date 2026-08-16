import { describe, expect, it } from 'vitest'
import type {
  GitGraphCommitDetailsDto,
  GitGraphFileChangeDto,
} from '@universe-editor/extensions-common'
import { buildCommitPayload, buildComparePayload } from '../commitChangesPayload.js'

const ROOT = 'C:/ws/repo'
const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function makeDetails(overrides: Partial<GitGraphCommitDetailsDto> = {}): GitGraphCommitDetailsDto {
  return {
    hash: HASH_A,
    parents: [HASH_B],
    author: 'Alice',
    authorEmail: 'alice@example.com',
    authorDate: 1700000000,
    committer: 'Alice',
    committerEmail: 'alice@example.com',
    committerDate: 1700000001,
    body: 'fix crash\n\nlong body',
    files: [{ status: 'M', path: 'src/a.ts', oldPath: null }],
    ...overrides,
  }
}

describe('buildCommitPayload', () => {
  it('builds the single-commit payload', () => {
    const payload = buildCommitPayload(ROOT, makeDetails())
    expect(payload.providerId).toBe('git')
    expect(payload.title).toBe('aaaaaaa — fix crash')
    expect(payload.subtitle).toBe(`Alice · ${new Date(1700000000 * 1000).toLocaleString()}`)
    expect(payload.commitRef).toBe(HASH_A)
    expect(payload.openExternalCommand).toBe('git-graph.openFileDiff')
    expect(payload.metadata).toEqual({
      author: 'Alice',
      authorDate: 1700000000,
      message: 'fix crash\n\nlong body',
      parents: [HASH_B],
    })
    expect(payload.files).toEqual([
      {
        path: 'src/a.ts',
        oldPath: null,
        status: 'M',
        resourcePath: 'C:/ws/repo/src/a.ts',
        args: { root: ROOT, fromHash: HASH_B, toHash: HASH_A, path: 'src/a.ts', status: 'M' },
      },
    ])
  })

  it('falls back to the empty tree when the commit has no parents', () => {
    const payload = buildCommitPayload(ROOT, makeDetails({ parents: [] }))
    expect(payload.files[0]?.args).toEqual({
      root: ROOT,
      fromHash: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      toHash: HASH_A,
      path: 'src/a.ts',
      status: 'M',
    })
  })

  it('spreads oldPath into args only for renames', () => {
    const files: GitGraphFileChangeDto[] = [
      { status: 'R', path: 'src/new.ts', oldPath: 'src/old.ts' },
      { status: 'M', path: 'src/a.ts', oldPath: null },
    ]
    const payload = buildCommitPayload(ROOT, makeDetails({ files }))
    expect(payload.files[0]?.oldPath).toBe('src/old.ts')
    expect(payload.files[0]?.args).toEqual({
      root: ROOT,
      fromHash: HASH_B,
      toHash: HASH_A,
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      status: 'R',
    })
    expect(payload.files[1]?.args).not.toHaveProperty('oldPath')
  })
})

describe('buildComparePayload', () => {
  it('builds the compare payload', () => {
    const files: GitGraphFileChangeDto[] = [{ status: 'M', path: 'src/a.ts', oldPath: null }]
    const payload = buildComparePayload(ROOT, HASH_A, HASH_B, files)
    expect(payload.providerId).toBe('git')
    expect(payload.title).toBe('aaaaaaa ↔ bbbbbbb')
    expect(payload.commitRef).toBe(`${HASH_A}..${HASH_B}`)
    expect(payload.openExternalCommand).toBe('git-graph.openFileDiff')
    expect(payload.metadata).toEqual({ compareRefs: { from: HASH_A, to: HASH_B } })
    expect(payload.files[0]?.args).toEqual({
      root: ROOT,
      fromHash: HASH_A,
      toHash: HASH_B,
      path: 'src/a.ts',
      status: 'M',
    })
    expect(payload.files[0]?.resourcePath).toBe('C:/ws/repo/src/a.ts')
  })
})
