/*---------------------------------------------------------------------------------------------
 *  Manual-refresh acknowledgement: the title-bar Refresh command awaits
 *  `requestSwarmReviewsRefresh()` for its disabled/spinning state, so the
 *  promise must only settle once the view's reload did — and never hang when
 *  no view is consuming (or the consumer unmounted mid-flight).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { SwarmReviewDetailDto } from '@universe-editor/extensions-common'
import {
  fingerprintSwarmVersions,
  requestSwarmReviewsRefresh,
  resolveSwarmReviewsRefresh,
  swarmReviewEvents,
  trackSwarmRefreshConsumer,
} from '../swarmViewState.js'

type Versions = SwarmReviewDetailDto['versions']

describe('fingerprintSwarmVersions', () => {
  it('handles an empty versions list', () => {
    expect(fingerprintSwarmVersions([])).toBe('0:')
  })

  it('changes when a version is appended', () => {
    const before: Versions = [{ version: 1, change: '2001', pending: true, time: 1 }]
    const after: Versions = [...before, { version: 2, change: '2002', pending: true, time: 2 }]
    expect(fingerprintSwarmVersions(before)).toBe('1:2001')
    expect(fingerprintSwarmVersions(after)).toBe('2:2002')
    expect(fingerprintSwarmVersions(after)).not.toBe(fingerprintSwarmVersions(before))
  })

  it('prefers the immutable archiveChange over the re-shelvable author change', () => {
    const versions: Versions = [
      { version: 1, change: '2001', pending: true, time: 1 },
      { version: 2, change: '2002', archiveChange: '2999', pending: true, time: 2 },
    ]
    expect(fingerprintSwarmVersions(versions)).toBe('2:2999')
  })

  it('never keys on the rev: same rev, different change → different fingerprint', () => {
    // Re-shelves of an unapproved review all report the same rev (it only
    // increments on approve), so the rev must not feed the fingerprint.
    const a: Versions = [
      { version: 1, change: '910', pending: true, time: 1 },
      { version: 1, change: '911', pending: true, time: 2 },
    ]
    const b: Versions = [
      { version: 1, change: '910', pending: true, time: 1 },
      { version: 1, change: '912', pending: true, time: 2 },
    ]
    expect(fingerprintSwarmVersions(a)).not.toBe(fingerprintSwarmVersions(b))
  })
})

describe('swarm refresh request acknowledgement', () => {
  it('resolves immediately when no view is consuming', async () => {
    await expect(requestSwarmReviewsRefresh()).resolves.toBeUndefined()
  })

  it('stays pending until the view settles the reload', async () => {
    const consumer = trackSwarmRefreshConsumer()
    try {
      let fired = 0
      const sub = swarmReviewEvents.onDidRequestRefresh(() => {
        fired++
      })
      let resolved = false
      const p = requestSwarmReviewsRefresh().then(() => {
        resolved = true
      })
      expect(fired).toBe(1)
      await Promise.resolve()
      expect(resolved).toBe(false)

      resolveSwarmReviewsRefresh()
      await p
      expect(resolved).toBe(true)
      sub.dispose()
    } finally {
      consumer.dispose()
    }
  })

  it('flushes a pending request when the consumer unmounts', async () => {
    const consumer = trackSwarmRefreshConsumer()
    let resolved = false
    const p = requestSwarmReviewsRefresh().then(() => {
      resolved = true
    })
    consumer.dispose()
    await p
    expect(resolved).toBe(true)
  })

  it('coalesces multiple in-flight requests into one flush', async () => {
    const consumer = trackSwarmRefreshConsumer()
    try {
      const results: string[] = []
      const p1 = requestSwarmReviewsRefresh().then(() => results.push('a'))
      const p2 = requestSwarmReviewsRefresh().then(() => results.push('b'))
      resolveSwarmReviewsRefresh()
      await Promise.all([p1, p2])
      expect(results).toEqual(['a', 'b'])
    } finally {
      consumer.dispose()
    }
  })

  it('carries the force flag (default true, soft refresh false)', async () => {
    const consumer = trackSwarmRefreshConsumer()
    try {
      const seen: boolean[] = []
      const sub = swarmReviewEvents.onDidRequestRefresh((e) => {
        seen.push(e.force)
        resolveSwarmReviewsRefresh()
      })
      await requestSwarmReviewsRefresh()
      await requestSwarmReviewsRefresh(false)
      expect(seen).toEqual([true, false])
      sub.dispose()
    } finally {
      consumer.dispose()
    }
  })
})
