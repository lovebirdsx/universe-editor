/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/gitGraph/graphOutline.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import { observableValue } from '@universe-editor/platform'
import {
  GRAPH_COMMIT_KIND,
  GRAPH_PENDING_KIND,
  GIT_GRAPH_OUTLINE_LANGUAGE_ID,
  GraphOutlineRegistry,
  graphCommitsToOutline,
  type GraphOutlineCommit,
  type IGraphOutlineController,
} from '../graphOutline.js'

function commit(hash: string, overrides: Partial<GraphOutlineCommit> = {}): GraphOutlineCommit {
  return { hash, label: `subject of ${hash}`, detail: `${hash} · alice · 2026-08-01`, ...overrides }
}

describe('graphCommitsToOutline', () => {
  it('maps each commit to a flat symbol on its own pseudo-line, in display order', () => {
    const { roots, keyByLine, lineByKey } = graphCommitsToOutline([
      commit('aaa'),
      commit('bbb'),
      commit('ccc'),
    ])

    expect(roots.map((r) => r.name)).toEqual(['subject of aaa', 'subject of bbb', 'subject of ccc'])
    expect(roots.map((r) => r.selectionRange.startLineNumber)).toEqual([1, 2, 3])
    expect(roots.map((r) => r.kind)).toEqual([
      GRAPH_COMMIT_KIND,
      GRAPH_COMMIT_KIND,
      GRAPH_COMMIT_KIND,
    ])
    expect(roots[1]!.detail).toBe('bbb · alice · 2026-08-01')
    expect(roots.every((r) => r.children?.length === 0)).toBe(true)

    // The hash↔line bridge is symmetric and covers every row.
    expect(keyByLine.get(2)).toBe('bbb')
    expect(lineByKey.get('bbb')).toBe(2)
    expect(lineByKey.get('missing')).toBeUndefined()
  })

  it('marks uncommitted / pending rows with the pending sentinel kind', () => {
    const { roots } = graphCommitsToOutline([commit('*', { pending: true }), commit('aaa')])
    expect(roots[0]!.kind).toBe(GRAPH_PENDING_KIND)
    expect(roots[1]!.kind).toBe(GRAPH_COMMIT_KIND)
  })

  it('yields an empty tree for an empty commit list', () => {
    const { roots, keyByLine, lineByKey } = graphCommitsToOutline([])
    expect(roots).toEqual([])
    expect(keyByLine.size).toBe(0)
    expect(lineByKey.size).toBe(0)
  })
})

describe('GraphOutlineRegistry', () => {
  beforeEach(() => {
    GraphOutlineRegistry._resetForTests()
  })

  function makeController(): IGraphOutlineController {
    return {
      commits: observableValue<readonly GraphOutlineCommit[]>('t', []),
      selectCommit: () => {},
      scrollToCommit: () => {},
      getSelectedHash: () => undefined,
      onDidChangeSelection: () => ({ dispose: () => {} }),
    }
  }

  it('returns the latest registered controller (last wins) and fires onDidChange', () => {
    const seen: string[] = []
    const sub = GraphOutlineRegistry.onDidChange((kind) => seen.push(kind))

    const first = makeController()
    const second = makeController()
    GraphOutlineRegistry.register(GIT_GRAPH_OUTLINE_LANGUAGE_ID, first)
    expect(GraphOutlineRegistry.get(GIT_GRAPH_OUTLINE_LANGUAGE_ID)).toBe(first)
    GraphOutlineRegistry.register(GIT_GRAPH_OUTLINE_LANGUAGE_ID, second)
    expect(GraphOutlineRegistry.get(GIT_GRAPH_OUTLINE_LANGUAGE_ID)).toBe(second)
    expect(seen).toEqual([GIT_GRAPH_OUTLINE_LANGUAGE_ID, GIT_GRAPH_OUTLINE_LANGUAGE_ID])

    GraphOutlineRegistry.unregister(GIT_GRAPH_OUTLINE_LANGUAGE_ID, second)
    expect(GraphOutlineRegistry.get(GIT_GRAPH_OUTLINE_LANGUAGE_ID)).toBe(first)
    GraphOutlineRegistry.unregister(GIT_GRAPH_OUTLINE_LANGUAGE_ID, first)
    expect(GraphOutlineRegistry.get(GIT_GRAPH_OUTLINE_LANGUAGE_ID)).toBeUndefined()

    sub.dispose()
  })

  it('ignores unregistering a controller that was never registered', () => {
    const other = makeController()
    expect(() =>
      GraphOutlineRegistry.unregister(GIT_GRAPH_OUTLINE_LANGUAGE_ID, other),
    ).not.toThrow()
    expect(GraphOutlineRegistry.get(GIT_GRAPH_OUTLINE_LANGUAGE_ID)).toBeUndefined()
  })
})
