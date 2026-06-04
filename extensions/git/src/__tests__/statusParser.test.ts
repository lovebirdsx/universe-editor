import { describe, expect, it } from 'vitest'
import { parseStatus } from '../statusParser.js'

/** Build a NUL-delimited porcelain-v2 -z payload from entry strings. */
function z(...entries: string[]): string {
  return entries.join('\0') + '\0'
}

describe('parseStatus', () => {
  it('reads branch name and ahead/behind from headers', () => {
    const status = parseStatus(
      z('# branch.oid abc123', '# branch.head feature/x', '# branch.ab +3 -1'),
    )
    expect(status.branch).toBe('feature/x')
    expect(status.ahead).toBe(3)
    expect(status.behind).toBe(1)
    expect(status.files).toEqual([])
  })

  it('treats a detached HEAD as no branch', () => {
    const status = parseStatus(z('# branch.head (detached)'))
    expect(status.branch).toBeUndefined()
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
