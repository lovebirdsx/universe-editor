/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/command/invocationModifiers.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  getInvocationModifiers,
  runWithInvocationModifiers,
} from '../../command/invocationModifiers.js'

describe('invocationModifiers', () => {
  it('is undefined outside a gesture', () => {
    expect(getInvocationModifiers()).toBeUndefined()
  })

  it('exposes the modifiers only during the synchronous call', async () => {
    let seen: unknown
    let afterAwait: unknown
    const pending = runWithInvocationModifiers({ ctrlKey: true }, async () => {
      seen = getInvocationModifiers()
      await Promise.resolve()
      afterAwait = getInvocationModifiers()
    })
    expect(getInvocationModifiers()).toBeUndefined()
    await pending
    expect(seen).toMatchObject({ ctrlKey: true })
    expect(afterAwait).toBeUndefined()
  })

  it('snapshots the event so later mutation does not leak in', () => {
    const event = { ctrlKey: false, altKey: true }
    runWithInvocationModifiers(event, () => {
      event.altKey = false
      expect(getInvocationModifiers()?.altKey).toBe(true)
    })
  })

  it('restores the outer value when nested and on throw', () => {
    runWithInvocationModifiers({ altKey: true }, () => {
      expect(() =>
        runWithInvocationModifiers({ ctrlKey: true }, () => {
          expect(getInvocationModifiers()?.ctrlKey).toBe(true)
          throw new Error('boom')
        }),
      ).toThrow('boom')
      expect(getInvocationModifiers()?.altKey).toBe(true)
    })
    expect(getInvocationModifiers()).toBeUndefined()
  })
})
