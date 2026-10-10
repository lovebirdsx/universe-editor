import { describe, expect, it } from 'vitest'
import { parseStatus } from '../statusParser.js'

/** Build a NUL-delimited porcelain-v2 -z payload from entry strings. */
function z(...entries: string[]): string {
  return entries.join('\0') + '\0'
}

describe('parseStatus', () => {
  it('reads branch name, ahead/behind and HEAD oid from headers', () => {
    const status = parseStatus(
      z('# branch.oid abc123', '# branch.head feature/x', '# branch.ab +3 -1'),
    )
    expect(status.branch).toBe('feature/x')
    expect(status.ahead).toBe(3)
    expect(status.behind).toBe(1)
    expect(status.headRevision).toBe('abc123')
    expect(status.files).toEqual([])
  })

  it('treats a detached HEAD as no branch but still reports its HEAD oid', () => {
    const status = parseStatus(z('# branch.oid deadbeef', '# branch.head (detached)'))
    expect(status.branch).toBeUndefined()
    expect(status.headRevision).toBe('deadbeef')
  })

  it('reads the upstream ref when the branch is published', () => {
    const status = parseStatus(
      z(
        '# branch.oid abc123',
        '# branch.head feature/x',
        '# branch.upstream origin/feature/x',
        '# branch.ab +0 -0',
      ),
    )
    expect(status.upstream).toBe('origin/feature/x')
  })

  it('leaves upstream undefined for a branch that was never published', () => {
    // Porcelain omits both `branch.upstream` and `branch.ab` here, so ahead /
    // behind stay 0 and only this field tells the two cases apart.
    const status = parseStatus(z('# branch.oid abc123', '# branch.head feature/x'))
    expect(status.branch).toBe('feature/x')
    expect(status.upstream).toBeUndefined()
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
  })

  it('still reads the upstream line git prints for a detached HEAD', () => {
    // Detached HEAD reports the branch it was detached from; consumers key the
    // publish decision on `branch`, not on this stray line.
    const status = parseStatus(
      z('# branch.oid deadbeef', '# branch.head (detached)', '# branch.upstream origin/main'),
    )
    expect(status.branch).toBeUndefined()
    expect(status.upstream).toBe('origin/main')
  })

  it('reports no HEAD revision for an empty repo (`branch.oid (initial)`)', () => {
    const status = parseStatus(z('# branch.oid (initial)', '# branch.head main'))
    expect(status.headRevision).toBeUndefined()
    expect(status.upstream).toBeUndefined()
  })

  it('splits ordinary entries into index (X) and working-tree (Y) status', () => {
    const status = parseStatus(
      z(
        '1 .M N... 100644 100644 100644 1111 2222 working.ts',
        '1 M. N... 100644 100644 100644 1111 2222 staged.ts',
        '1 MM N... 100644 100644 100644 1111 2222 both.ts',
      ),
    )
    expect(status.files).toEqual([
      { path: 'working.ts', index: '.', workingTree: 'M', kind: 'tracked' },
      { path: 'staged.ts', index: 'M', workingTree: '.', kind: 'tracked' },
      { path: 'both.ts', index: 'M', workingTree: 'M', kind: 'tracked' },
    ])
  })

  it('keeps paths that contain spaces intact', () => {
    const status = parseStatus(z('1 .M N... 100644 100644 100644 1111 2222 my file.ts'))
    expect(status.files[0]?.path).toBe('my file.ts')
  })

  it('marks untracked files', () => {
    const status = parseStatus(z('? newfile.ts'))
    expect(status.files).toEqual([
      { path: 'newfile.ts', index: '.', workingTree: '?', kind: 'untracked' },
    ])
  })

  it('reads the original path from a rename entry (two NUL fields)', () => {
    const status = parseStatus(
      z('2 R. N... 100644 100644 100644 1111 2222 R100 new-name.ts', 'old-name.ts'),
    )
    expect(status.files).toEqual([
      {
        path: 'new-name.ts',
        index: 'R',
        workingTree: '.',
        kind: 'tracked',
        origPath: 'old-name.ts',
      },
    ])
  })

  it('flags unmerged entries as conflicts', () => {
    const status = parseStatus(z('u UU N... 100644 100644 100644 100644 1 2 3 conflict.ts'))
    expect(status.files[0]).toMatchObject({ path: 'conflict.ts', kind: 'unmerged' })
  })

  it('drops ignored entries and a mix of types parses fully', () => {
    const status = parseStatus(
      z(
        '# branch.head main',
        '1 M. N... 100644 100644 100644 1111 2222 staged.ts',
        '? untracked.ts',
        '! ignored.ts',
      ),
    )
    expect(status.branch).toBe('main')
    expect(status.files.map((f) => f.path)).toEqual(['staged.ts', 'untracked.ts'])
  })
})
