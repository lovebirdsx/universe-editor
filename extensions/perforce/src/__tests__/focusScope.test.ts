import { describe, expect, it } from 'vitest'
import { resolveFocusScopeDirs } from '../focusScope.js'

const ROOT = process.platform === 'win32' ? 'C:/ws' : '/ws'

function resolve(enabled: boolean, folders: Record<string, unknown>): string[] {
  return resolveFocusScopeDirs({ enabled, folders }, ROOT)
}

describe('resolveFocusScopeDirs', () => {
  it('returns [] when focus is disabled, whatever the folders', () => {
    expect(resolve(false, { Client: true })).toEqual([])
  })

  it('returns [] when no key is exactly true', () => {
    expect(resolve(true, {})).toEqual([])
    expect(resolve(true, { Client: false })).toEqual([])
    expect(resolve(true, { Client: 'true' })).toEqual([])
    expect(resolve(true, { Client: 1 })).toEqual([])
  })

  it('joins true-valued keys onto the workspace root as absolute dirs', () => {
    expect(resolve(true, { Client: true, Server: true })).toEqual([
      `${ROOT}/Client`,
      `${ROOT}/Server`,
    ])
  })

  it('normalizes backslashes and strips leading/trailing separators', () => {
    expect(resolve(true, { 'Client\\Tools\\': true, '/Client/UI': true })).toEqual([
      `${ROOT}/Client/Tools`,
      `${ROOT}/Client/UI`,
    ])
  })

  it('resolves internal .. segments', () => {
    expect(resolve(true, { 'Client/../Server': true })).toEqual([`${ROOT}/Server`])
  })

  it('drops entries addressing the root itself or escaping it (no clamping)', () => {
    expect(
      resolve(true, { '.': true, '/': true, '': true, '../outside': true, 'a/../../b': true }),
    ).toEqual([])
  })

  it('collapses nested entries to the shallowest ancestor, either order', () => {
    expect(resolve(true, { Client: true, 'Client/Tools': true })).toEqual([`${ROOT}/Client`])
    expect(resolve(true, { 'Client/Tools': true, Client: true })).toEqual([`${ROOT}/Client`])
  })

  it('keeps sibling directories that only share a prefix', () => {
    expect(resolve(true, { Client: true, ClientTools: true })).toEqual([
      `${ROOT}/Client`,
      `${ROOT}/ClientTools`,
    ])
  })

  it('keeps one entry when two differ only by case on a case-insensitive host', () => {
    // Guard: dedupe and the nesting collapse must key identically. Keyed
    // differently, both survive dedupe, then each looks nested under the other
    // and BOTH get dropped — the scan silently widens back to the whole folder.
    const dirs = resolve(true, { Client: true, client: true })
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(dirs).toEqual([`${ROOT}/Client`])
    } else {
      expect(dirs).toEqual([`${ROOT}/Client`, `${ROOT}/client`])
    }
  })

  it('collapses nesting case-insensitively on a case-insensitive host', () => {
    const dirs = resolve(true, { Client: true, 'client/Tools': true })
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(dirs).toEqual([`${ROOT}/Client`])
    } else {
      expect(dirs).toEqual([`${ROOT}/Client`, `${ROOT}/client/Tools`])
    }
  })
})
