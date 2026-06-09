import { describe, expect, it } from 'vitest'
import { parseIncrementalBlame } from '../blameSource.js'

/** One commit block in `git blame --incremental` format. */
function block(
  hash: string,
  finalLine: number,
  numLines: number,
  meta: Partial<{ author: string; mail: string; time: number; summary: string }> = {},
): string {
  const lines = [`${hash} 1 ${finalLine} ${numLines}`]
  if (meta.author !== undefined) lines.push(`author ${meta.author}`)
  if (meta.mail !== undefined) lines.push(`author-mail <${meta.mail}>`)
  if (meta.time !== undefined) lines.push(`author-time ${meta.time}`)
  if (meta.summary !== undefined) lines.push(`summary ${meta.summary}`)
  lines.push('filename file.ts')
  return lines.join('\n')
}

const HASH_A = 'a'.repeat(40)
const HASH_B = 'b'.repeat(40)
const ZERO = '0'.repeat(40)

describe('parseIncrementalBlame', () => {
  it('parses a single commit block', () => {
    const out = parseIncrementalBlame(
      block(HASH_A, 1, 2, { author: 'Ada', mail: 'ada@x.io', time: 1700000000, summary: 'init' }),
    )
    expect(out.commits).toEqual([
      {
        hash: HASH_A,
        authorName: 'Ada',
        authorEmail: 'ada@x.io',
        authorDate: 1700000000 * 1000,
        summary: 'init',
        ranges: [{ startLine: 1, endLine: 2 }],
      },
    ])
    expect(out.uncommittedLines).toEqual([])
  })

  it('merges multiple ranges owned by the same commit', () => {
    const out = parseIncrementalBlame(
      [
        block(HASH_A, 1, 1, { author: 'Ada', summary: 's' }),
        // Second appearance of the same hash carries no metadata.
        block(HASH_A, 5, 2),
      ].join('\n'),
    )
    expect(out.commits).toHaveLength(1)
    expect(out.commits[0]?.ranges).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 5, endLine: 6 },
    ])
  })

  it('keeps distinct commits separate', () => {
    const out = parseIncrementalBlame(
      [block(HASH_A, 1, 1, { author: 'Ada' }), block(HASH_B, 2, 1, { author: 'Bo' })].join('\n'),
    )
    expect(out.commits.map((c) => c.hash)).toEqual([HASH_A, HASH_B])
  })

  it('reports all-zero-hash lines as uncommitted', () => {
    const out = parseIncrementalBlame(
      [block(HASH_A, 1, 1, { author: 'Ada' }), block(ZERO, 2, 3)].join('\n'),
    )
    expect(out.commits.map((c) => c.hash)).toEqual([HASH_A])
    expect(out.uncommittedLines).toEqual([2, 3, 4])
  })

  it('tolerates CRLF line endings', () => {
    const out = parseIncrementalBlame(
      block(HASH_A, 1, 1, { author: 'Ada', summary: 's' }).replace(/\n/g, '\r\n'),
    )
    expect(out.commits[0]?.authorName).toBe('Ada')
  })
})
