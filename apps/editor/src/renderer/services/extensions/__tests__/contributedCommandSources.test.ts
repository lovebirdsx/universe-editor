/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { getCommandSourceExtensionId, registerCommandSource } from '../contributedCommandSources.js'

describe('contributedCommandSources', () => {
  it('returns the extension id while registered and undefined after dispose', () => {
    const handle = registerCommandSource('test.cs.basic', 'pub.ext')
    expect(getCommandSourceExtensionId('test.cs.basic')).toBe('pub.ext')
    handle.dispose()
    expect(getCommandSourceExtensionId('test.cs.basic')).toBeUndefined()
  })

  it('a stale handle does not clear a newer registration for the same command', () => {
    const first = registerCommandSource('test.cs.race', 'pub.old')
    const second = registerCommandSource('test.cs.race', 'pub.new')
    first.dispose()
    expect(getCommandSourceExtensionId('test.cs.race')).toBe('pub.new')
    second.dispose()
    expect(getCommandSourceExtensionId('test.cs.race')).toBeUndefined()
  })

  it('tracks commands independently', () => {
    const a = registerCommandSource('test.cs.a', 'pub.a')
    const b = registerCommandSource('test.cs.b', 'pub.b')
    a.dispose()
    expect(getCommandSourceExtensionId('test.cs.b')).toBe('pub.b')
    b.dispose()
  })
})
