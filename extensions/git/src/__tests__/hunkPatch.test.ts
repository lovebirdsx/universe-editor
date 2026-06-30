import { describe, expect, it } from 'vitest'
import { selectHunkPatch } from '../hunkPatch.js'

// Minimal `git diff -U0` shapes. The file header is preserved verbatim and the
// one hunk overlapping the queried current-document range is kept.
const HEADER = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '',
].join('\n')

describe('selectHunkPatch', () => {
  it('returns undefined when there is no hunk', () => {
    expect(selectHunkPatch('', 1, 1)).toBeUndefined()
  })

  it('selects the single hunk covering a modified line', () => {
    const diff = HEADER + ['@@ -2 +2 @@', '-b', '+B', ''].join('\n')
    const patch = selectHunkPatch(diff, 2, 2)
    expect(patch).toBe(HEADER + '@@ -2 +2 @@\n-b\n+B\n')
  })

  it('keeps only the overlapping hunk out of several', () => {
    const diff = HEADER + ['@@ -2 +2 @@', '-b', '+B', '@@ -6,0 +7 @@', '+f', ''].join('\n')
    expect(selectHunkPatch(diff, 7, 7)).toBe(HEADER + '@@ -6,0 +7 @@\n+f\n')
    expect(selectHunkPatch(diff, 2, 2)).toBe(HEADER + '@@ -2 +2 @@\n-b\n+B\n')
  })

  it('matches an insertion hunk by its modified start line', () => {
    const diff = HEADER + ['@@ -1,0 +2,2 @@', '+x', '+y', ''].join('\n')
    expect(selectHunkPatch(diff, 3, 3)).toBe(HEADER + '@@ -1,0 +2,2 @@\n+x\n+y\n')
  })

  it('matches a pure deletion at its anchor line or the next', () => {
    const diff = HEADER + ['@@ -3 +2,0 @@', '-c', ''].join('\n')
    expect(selectHunkPatch(diff, 2, 2)).toBe(HEADER + '@@ -3 +2,0 @@\n-c\n')
    expect(selectHunkPatch(diff, 3, 3)).toBe(HEADER + '@@ -3 +2,0 @@\n-c\n')
  })

  it('returns undefined when the range misses every hunk', () => {
    const diff = HEADER + ['@@ -2 +2 @@', '-b', '+B', ''].join('\n')
    expect(selectHunkPatch(diff, 10, 10)).toBeUndefined()
  })

  it('preserves a no-newline-at-eof marker in the hunk body', () => {
    const diff = HEADER + ['@@ -2 +2 @@', '-b', '+B', '\\ No newline at end of file', ''].join('\n')
    expect(selectHunkPatch(diff, 2, 2)).toBe(
      HEADER + '@@ -2 +2 @@\n-b\n+B\n\\ No newline at end of file\n',
    )
  })
})
