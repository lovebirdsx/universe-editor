/*---------------------------------------------------------------------------------------------
 *  Tests for the universe-app allow-list boundary checks.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { allowResourceRoots, isPathAllowed, clearResourceRoots } from '../resourceRoots.js'

const root = resolve('/proj/docs')

afterEach(() => clearResourceRoots())

describe('isPathAllowed', () => {
  it('rejects everything when no roots are granted', () => {
    expect(isPathAllowed(join(root, 'a.png'))).toBe(false)
  })

  it('allows a file directly inside a granted root', () => {
    allowResourceRoots([root])
    expect(isPathAllowed(join(root, 'a.png'))).toBe(true)
  })

  it('allows a file nested deeper under a granted root', () => {
    allowResourceRoots([root])
    expect(isPathAllowed(join(root, 'assets', 'sub', 'b.png'))).toBe(true)
  })

  it('rejects a path that escapes the root via ..', () => {
    allowResourceRoots([root])
    expect(isPathAllowed(join(root, '..', 'secret.png'))).toBe(false)
  })

  it('rejects a sibling directory sharing a name prefix', () => {
    allowResourceRoots([resolve('/proj/doc')])
    // /proj/docs must not match the granted /proj/doc
    expect(isPathAllowed(join(resolve('/proj/docs'), 'a.png'))).toBe(false)
  })

  it('honors multiple granted roots', () => {
    const other = resolve('/work/img')
    allowResourceRoots([root, other])
    expect(isPathAllowed(join(other, 'c.png'))).toBe(true)
    expect(isPathAllowed(join(root, 'd.png'))).toBe(true)
    expect(isPathAllowed(resolve('/elsewhere/e.png'))).toBe(false)
  })
})
