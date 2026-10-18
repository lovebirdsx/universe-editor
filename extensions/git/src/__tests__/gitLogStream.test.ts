import { describe, expect, it } from 'vitest'
import {
  FIELD,
  CommitLogParser,
  buildLogArgs,
  buildRefArgs,
  mapLogRecord,
  type LogRefs,
} from '../gitLogStream.js'

function record(hash: string, subject: string, parents = '', date = 1_700_000_000): string {
  return [hash, parents, 'Ann', 'ann@example.com', String(date), subject].join(FIELD)
}

function emptyRefs(): LogRefs {
  return { heads: new Map(), tags: new Map(), remotes: new Map() }
}

describe('buildRefArgs / buildLogArgs', () => {
  it('covers branches, tags and HEAD, adding remotes on demand', () => {
    expect(buildRefArgs(true)).toEqual(['--branches', '--tags', '--remotes', 'HEAD'])
    expect(buildRefArgs(false)).toEqual(['--branches', '--tags', 'HEAD'])
  })

  it('maps the ordering and optional cap onto git arguments', () => {
    expect(buildLogArgs({ order: 'topo', includeRemotes: false })).toContain('--topo-order')
    expect(buildLogArgs({ order: 'author-date', includeRemotes: false })).toContain(
      '--author-date-order',
    )
    expect(buildLogArgs({ order: 'date', includeRemotes: false })).toContain('--date-order')
    expect(buildLogArgs({ includeRemotes: false, maxCount: 42 })).toContain('--max-count=42')
    expect(buildLogArgs({ includeRemotes: false })).not.toContain('--max-count=42')
  })
})

describe('CommitLogParser', () => {
  it('splits records on NUL across arbitrary chunk boundaries', () => {
    const parser = new CommitLogParser()
    const text = `${record('aaa', 'first')}\0${record('bbb', 'second')}\0`
    const records = [
      ...parser.push(Buffer.from(text.slice(0, 11))),
      ...parser.push(Buffer.from(text.slice(11, 40))),
      ...parser.push(Buffer.from(text.slice(40))),
    ]
    expect(records).toHaveLength(2)
    expect(records.map((r) => mapLogRecord(r, emptyRefs()).hash)).toEqual(['aaa', 'bbb'])
    expect(parser.end()).toEqual([])
  })

  it('holds a multi-byte UTF-8 character split across chunks', () => {
    const parser = new CommitLogParser()
    const text = `${record('aaa', '修复中文提交')}\0`
    const bytes = Buffer.from(text)
    // Cut in the middle of the first Chinese character (3 bytes each).
    const cut = bytes.indexOf(Buffer.from('修')) + 1
    expect(parser.push(bytes.subarray(0, cut))).toEqual([])
    const rest = parser.push(bytes.subarray(cut))
    expect(rest).toHaveLength(1)
    expect(mapLogRecord(rest[0]!, emptyRefs()).message).toBe('修复中文提交')
  })

  it('keeps an empty subject and re-joins stray field separators', () => {
    const parser = new CommitLogParser()
    const records = parser.push(Buffer.from(`${record('aaa', '')}\0${record('bbb', 'a\x1fb')}\0`))
    expect(mapLogRecord(records[0]!, emptyRefs()).message).toBe('')
    expect(mapLogRecord(records[1]!, emptyRefs()).message).toBe('a\x1fb')
  })

  it('drops the trailing partial record when told the exit was abnormal', () => {
    const parser = new CommitLogParser()
    expect(parser.push(Buffer.from(`${record('aaa', 'first')}\0`))).toHaveLength(1)
    parser.push(Buffer.from(record('bbb', 'trunc')))
    expect(parser.end(false)).toEqual([])
  })

  it('flushes a complete trailing record on end()', () => {
    const parser = new CommitLogParser()
    expect(parser.push(Buffer.from(record('aaa', 'first')))).toEqual([])
    const tail = parser.end()
    expect(tail).toHaveLength(1)
    expect(mapLogRecord(tail[0]!, emptyRefs()).hash).toBe('aaa')
  })
})

describe('mapLogRecord', () => {
  it('enriches a commit with its refs', () => {
    const refs = emptyRefs()
    refs.heads.set('aaa', ['main'])
    refs.tags.set('aaa', [{ name: 'v1', annotated: false }])
    refs.remotes.set('aaa', [{ name: 'origin/main', remote: 'origin' }])
    const commit = mapLogRecord(record('aaa', 'subject', 'parent1 parent2'), refs)
    expect(commit).toMatchObject({
      hash: 'aaa',
      parents: ['parent1', 'parent2'],
      author: 'Ann',
      email: 'ann@example.com',
      message: 'subject',
      heads: ['main'],
      tags: [{ name: 'v1', annotated: false }],
      remotes: [{ name: 'origin/main', remote: 'origin' }],
      stash: null,
      worktrees: [],
    })
    expect(commit.date).toBe(1_700_000_000)
  })
})
