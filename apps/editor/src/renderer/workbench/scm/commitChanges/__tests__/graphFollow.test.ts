/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the graph → Commit Changes silent follow: the gate (only when
 *  the view is in use and not already showing the ref), the silent flag on the
 *  applied payload, in-flight dedup, and latest-call-wins ordering.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'
import { commitChangesViewState } from '../viewState.js'
import { createCommitChangesFollower, shouldFollowGraphSelection } from '../graphFollow.js'

function payload(commitRef: string, providerId = 'git'): ShowCommitChangesPayload {
  return {
    providerId,
    title: commitRef,
    commitRef,
    openExternalCommand: 'git-graph.openFileDiff',
    files: [],
  }
}

afterEach(() => {
  commitChangesViewState._resetForTests()
})

describe('shouldFollowGraphSelection', () => {
  it('does not follow while the view has never been used', () => {
    expect(shouldFollowGraphSelection('git', 'abc')).toBe(false)
  })

  it('does not follow the commit the view already shows', () => {
    commitChangesViewState.show(payload('abc'))
    expect(shouldFollowGraphSelection('git', 'abc')).toBe(false)
  })

  it('follows a different commit of the same provider', () => {
    commitChangesViewState.show(payload('abc'))
    expect(shouldFollowGraphSelection('git', 'def')).toBe(true)
  })

  it('follows when the view shows another provider (even with a colliding ref)', () => {
    commitChangesViewState.show(payload('4521', 'perforce'))
    expect(shouldFollowGraphSelection('git', '4521')).toBe(true)
  })
})

describe('createCommitChangesFollower', () => {
  it('applies the built payload with silent: true', async () => {
    commitChangesViewState.show(payload('old'))
    const applied: ShowCommitChangesPayload[] = []
    const follow = createCommitChangesFollower({
      providerId: 'git',
      build: async (ref) => payload(ref),
      apply: async (p) => {
        applied.push(p)
      },
    })

    follow('new')
    await vi.waitFor(() => expect(applied).toHaveLength(1))
    expect(applied[0]!.commitRef).toBe('new')
    expect(applied[0]!.silent).toBe(true)
  })

  it('never fetches when the gate is closed', async () => {
    const build = vi.fn(async (ref: string) => payload(ref))
    const follow = createCommitChangesFollower({
      providerId: 'git',
      build,
      apply: async () => undefined,
    })

    follow('abc') // no payload shown yet
    await Promise.resolve()
    expect(build).not.toHaveBeenCalled()
  })

  it('does not refetch a ref that is already in flight', async () => {
    commitChangesViewState.show(payload('old'))
    let release: (() => void) | undefined
    const build = vi.fn(
      async (ref: string) =>
        new Promise<ShowCommitChangesPayload>((resolve) => {
          release = () => resolve(payload(ref))
        }),
    )
    const follow = createCommitChangesFollower({
      providerId: 'git',
      build,
      apply: async () => undefined,
    })

    follow('abc')
    follow('abc')
    expect(build).toHaveBeenCalledTimes(1)
    release?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('lets the latest call win when builds resolve out of order', async () => {
    commitChangesViewState.show(payload('old'))
    const releases = new Map<string, () => void>()
    const applied: string[] = []
    const follow = createCommitChangesFollower({
      providerId: 'git',
      build: (ref) =>
        new Promise<ShowCommitChangesPayload>((resolve) => {
          releases.set(ref, () => resolve(payload(ref)))
        }),
      apply: async (p) => {
        applied.push(p.commitRef)
      },
    })

    follow('a')
    follow('b')
    // The older build resolves last — its payload must be dropped.
    releases.get('b')!()
    releases.get('a')!()
    await vi.waitFor(() => expect(applied).toEqual(['b']))
  })

  it('allows a retry after a build produced no payload', async () => {
    commitChangesViewState.show(payload('old'))
    let produce = false
    const applied: string[] = []
    const build = vi.fn(async (ref: string) => (produce ? payload(ref) : null))
    const follow = createCommitChangesFollower({
      providerId: 'git',
      build,
      apply: async (p) => {
        applied.push(p.commitRef)
      },
    })

    follow('abc')
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
    // Let the null resolution settle (clears the in-flight marker).
    await new Promise((r) => setTimeout(r, 0))
    expect(applied).toHaveLength(0)
    produce = true
    follow('abc')
    await vi.waitFor(() => expect(applied).toEqual(['abc']))
  })
})
