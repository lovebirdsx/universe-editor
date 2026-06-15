import { describe, it, expect } from 'vitest'
import {
  selectChangedFiles,
  truncateFileDiff,
  buildUntrackedPatch,
  MAX_FILE_DIFF_CHARS,
} from '../commitContext.js'
import type { GitFileStatus } from '../statusParser.js'

function file(p: Partial<GitFileStatus> & { path: string }): GitFileStatus {
  return { index: '.', workingTree: '.', kind: 'tracked', ...p }
}

describe('selectChangedFiles', () => {
  it('uses only staged files when anything is staged', () => {
    const files = [
      file({ path: 'a.ts', index: 'M', workingTree: 'M' }),
      file({ path: 'b.ts', index: '.', workingTree: 'M' }),
      file({ path: 'c.ts', kind: 'untracked', workingTree: '?' }),
    ]
    expect(selectChangedFiles(files)).toEqual([{ path: 'a.ts', source: 'index' }])
  })

  it('falls back to working-tree changes plus untracked when nothing is staged', () => {
    const files = [
      file({ path: 'b.ts', index: '.', workingTree: 'M' }),
      file({ path: 'c.ts', kind: 'untracked', workingTree: '?' }),
      file({ path: 'd.ts', index: '.', workingTree: '.' }),
    ]
    expect(selectChangedFiles(files)).toEqual([
      { path: 'b.ts', source: 'worktree' },
      { path: 'c.ts', source: 'untracked' },
    ])
  })

  it('returns nothing when there are no changes', () => {
    expect(selectChangedFiles([])).toEqual([])
  })
})

describe('truncateFileDiff', () => {
  it('leaves short diffs untouched', () => {
    expect(truncateFileDiff('abc', 10)).toBe('abc')
  })

  it('truncates and annotates over-long diffs', () => {
    const out = truncateFileDiff('abcdef', 3)
    expect(out).toBe('abc\n[diff truncated: 3 more characters omitted]')
  })

  it('defaults to the per-file cap', () => {
    expect(truncateFileDiff('x'.repeat(MAX_FILE_DIFF_CHARS))).toHaveLength(MAX_FILE_DIFF_CHARS)
  })
})

describe('buildUntrackedPatch', () => {
  it('builds an all-added new-file patch with trailing newline', () => {
    expect(buildUntrackedPatch('a.txt', 'one\ntwo\n')).toBe(
      [
        'diff --git a/a.txt b/a.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/a.txt',
        '@@ -0,0 +1,2 @@',
        '+one\n+two',
      ].join('\n'),
    )
  })

  it('notes a missing trailing newline', () => {
    const out = buildUntrackedPatch('a.txt', 'one\ntwo')
    expect(out).toContain('@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file')
  })
})
