import { describe, expect, it } from 'vitest'
import type { GitGraphCommitDto } from '@universe-editor/extensions-common'
import {
  appendStreamedBatch,
  createStreamedCommitState,
  finishStreamedState,
  insertByDateDesc,
  materializeStreamedCommits,
  mergeShallowRefresh,
} from '../gitGraphLoadAll.js'

function commit(hash: string, date: number, stash = false): GitGraphCommitDto {
  return {
    hash,
    parents: [],
    author: 'a',
    email: 'a@example.com',
    date,
    message: hash,
    heads: [],
    tags: [],
    remotes: [],
    stash: stash ? ({ selector: 'stash@{0}' } as unknown as GitGraphCommitDto['stash']) : null,
    worktrees: [],
  }
}

const hashes = (commits: readonly GitGraphCommitDto[]) => commits.map((c) => c.hash)

describe('streamed commit bookkeeping', () => {
  it('derives the untouched tail from the pre-stream list on the first batch', () => {
    const base = [commit('a', 300), commit('b', 200), commit('c', 100)]
    const state = appendStreamedBatch(createStreamedCommitState(), base, [commit('a', 300)])
    expect(hashes(materializeStreamedCommits(state))).toEqual(['a', 'b', 'c'])
    expect(hashes(state.tail ?? [])).toEqual(['b', 'c'])
  })

  it('grows the streamed prefix and shrinks the tail without duplicating commits', () => {
    const base = [commit('a', 300), commit('b', 200), commit('c', 100)]
    let state = appendStreamedBatch(createStreamedCommitState(), base, [commit('a', 300)])
    state = appendStreamedBatch(state, base, [commit('b', 200)])
    expect(hashes(materializeStreamedCommits(state))).toEqual(['a', 'b', 'c'])
    expect(hashes(state.tail ?? [])).toEqual(['c'])
    state = appendStreamedBatch(state, base, [commit('c', 100)])
    expect(hashes(state.tail ?? [])).toEqual([])
    expect(hashes(materializeStreamedCommits(state))).toEqual(['a', 'b', 'c'])
  })

  it('drops the tail at completion so rewritten history cannot linger', () => {
    const base = [commit('a', 300), commit('stale', 250)]
    let state = appendStreamedBatch(createStreamedCommitState(), base, [commit('a', 300)])
    state = finishStreamedState(state)
    expect(hashes(materializeStreamedCommits(state))).toEqual(['a'])
  })
})

describe('insertByDateDesc', () => {
  it('inserts after every commit with the same date', () => {
    const list = [commit('a', 300), commit('b', 300), commit('c', 100)]
    insertByDateDesc(list, commit('stash', 300))
    expect(hashes(list)).toEqual(['a', 'b', 'stash', 'c'])
  })
})

describe('mergeShallowRefresh', () => {
  it('replaces the fresh prefix and keeps commits older than the page', () => {
    const old = [commit('a', 300), commit('b', 200), commit('c', 100)]
    const fresh = [commit('a', 300), commit('b', 200)]
    expect(hashes(mergeShallowRefresh(old, fresh))).toEqual(['a', 'b', 'c'])
  })

  it('drops commits rewritten out of the fresh prefix', () => {
    const old = [commit('a', 300), commit('b', 200), commit('c', 100)]
    const fresh = [commit('x', 300)]
    // The old tail is still kept by hash; rewritten history is dropped only at
    // stream completion, a shallow refresh intentionally trusts the saved tail.
    expect(hashes(mergeShallowRefresh(old, fresh))).toEqual(['x', 'a', 'b', 'c'])
  })

  it('keeps the complete current stash list and drops stale stash nodes', () => {
    const old = [
      commit('a', 300),
      commit('old-stash', 250, true),
      commit('b', 200),
      commit('c', 100),
    ]
    const fresh = [commit('a', 300), commit('new-stash', 150, true)]
    const merged = mergeShallowRefresh(old, fresh)
    expect(hashes(merged)).toEqual(['a', 'b', 'new-stash', 'c'])
  })

  it('places a stash older than the first page at its date position', () => {
    const old = [commit('a', 300), commit('b', 200)]
    const fresh = [commit('a', 300), commit('stash', 150, true)]
    const merged = mergeShallowRefresh(old, fresh)
    expect(hashes(merged)).toEqual(['a', 'b', 'stash'])
  })
})
