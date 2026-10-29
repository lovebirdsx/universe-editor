/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AcpToolCall, TimelineItem } from '../../../services/acp/session/acpSession.js'
import { buildExploreResultLinks, exploreResultPropsFor } from '../exploreResultLinks.js'

function toolCall(id: string, over: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    id,
    title: `tool ${id}`,
    kind: 'execute',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...over,
  }
}

function toolItem(id: string, over?: Partial<AcpToolCall>): TimelineItem {
  return { kind: 'toolCall', id, call: toolCall(id, over) }
}

function msgItem(id: string): TimelineItem {
  return {
    kind: 'message',
    id,
    message: { id, role: 'agent', text: '', blocks: [], streaming: false },
  }
}

describe('buildExploreResultLinks', () => {
  it('links a result card back to its spawn by slot key and report path', () => {
    const links = buildExploreResultLinks([
      toolItem('spawn', { subagent: true }),
      msgItem('m1'),
      toolItem('explore-result-a', {
        kind: 'edit',
        exploreResultOf: 'spawn',
        diffs: [{ path: '/repo/.claude/explore-results/a.md', oldText: '', newText: '# a' }],
      }),
    ])

    expect(links.get('spawn')).toEqual({
      key: 't:explore-result-a',
      path: '/repo/.claude/explore-results/a.md',
    })
  })

  it('keeps the path after the result card is memory-trimmed', () => {
    // trimToolCall drops the content but keeps diffs[].path precisely so
    // affordances like this one survive; createdFilePath() would return
    // undefined here, which is why the helper reads the diff directly.
    const links = buildExploreResultLinks([
      toolItem('explore-result-a', {
        kind: 'edit',
        exploreResultOf: 'spawn',
        memoryTrimmed: true,
        diffs: [{ path: '/repo/.claude/explore-results/a.md', oldText: '', newText: '' }],
      }),
    ])

    expect(links.get('spawn')?.path).toBe('/repo/.claude/explore-results/a.md')
  })

  it('still links a card that has no diff, leaving the path undefined', () => {
    const links = buildExploreResultLinks([
      toolItem('explore-result-a', { exploreResultOf: 'spawn', diffs: [] }),
    ])

    const link = links.get('spawn')
    expect(link?.key).toBe('t:explore-result-a')
    expect(link).not.toHaveProperty('path')
  })

  it('ignores messages and tool calls without a backlink', () => {
    const links = buildExploreResultLinks([
      msgItem('m1'),
      toolItem('plain'),
      toolItem('explore-result-a', { exploreResultOf: 'spawn' }),
    ])

    expect([...links.keys()]).toEqual(['spawn'])
  })

  it('lets a later result card for the same spawn win', () => {
    // A resumed Explore updates the same synthetic card in place; should a
    // second card ever appear, the newest one is the one to jump to.
    const links = buildExploreResultLinks([
      toolItem('explore-result-old', {
        exploreResultOf: 'spawn',
        diffs: [{ path: '/old.md', oldText: '', newText: '' }],
      }),
      toolItem('explore-result-new', {
        exploreResultOf: 'spawn',
        diffs: [{ path: '/new.md', oldText: '', newText: '' }],
      }),
    ])

    expect(links.get('spawn')).toEqual({ key: 't:explore-result-new', path: '/new.md' })
  })
})

describe('exploreResultPropsFor', () => {
  it('returns the key and path for the linked spawn card', () => {
    const links = buildExploreResultLinks([
      toolItem('explore-result-a', {
        exploreResultOf: 'spawn',
        diffs: [{ path: '/repo/a.md', oldText: '', newText: '' }],
      }),
    ])

    expect(exploreResultPropsFor(links, toolItem('spawn', { subagent: true }))).toEqual({
      exploreResultKey: 't:explore-result-a',
      exploreResultPath: '/repo/a.md',
    })
  })

  it('omits the path when the result card has no diff', () => {
    const links = buildExploreResultLinks([
      toolItem('explore-result-a', { exploreResultOf: 'spawn' }),
    ])

    expect(exploreResultPropsFor(links, toolItem('spawn'))).toEqual({
      exploreResultKey: 't:explore-result-a',
    })
  })

  it('returns an empty object for unlinked tool calls and non-tool slots', () => {
    const links = buildExploreResultLinks([
      toolItem('explore-result-a', { exploreResultOf: 'spawn' }),
    ])

    expect(exploreResultPropsFor(links, toolItem('other'))).toEqual({})
    expect(exploreResultPropsFor(links, msgItem('spawn'))).toEqual({})
  })
})
