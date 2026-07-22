/*---------------------------------------------------------------------------------------------
 *  Manual-refresh acknowledgement: the title-bar Refresh command awaits
 *  `requestSwarmReviewsRefresh()` for its disabled/spinning state, so the
 *  promise must only settle once the view's reload did — and never hang when
 *  no view is consuming (or the consumer unmounted mid-flight).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  requestSwarmReviewsRefresh,
  resolveSwarmReviewsRefresh,
  swarmReviewEvents,
  trackSwarmRefreshConsumer,
} from '../swarmViewState.js'

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
})
