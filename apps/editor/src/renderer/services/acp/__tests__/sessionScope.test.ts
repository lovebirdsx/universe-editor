/*---------------------------------------------------------------------------------------------
 *  Tests for the prompt suggestion scope: a session rooted at a strict
 *  subdirectory of the open folder narrows to that directory, every other cwd
 *  keeps the workspace root.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { REMOTE_SCHEME, URI, UriIdentityService } from '@universe-editor/platform'
import { resolveSessionScopeRoot } from '../sessionScope.js'

const linux = new UriIdentityService('linux')
const win32 = new UriIdentityService('win32')

describe('resolveSessionScopeRoot', () => {
  it('returns undefined without a workspace folder', () => {
    expect(resolveSessionScopeRoot(undefined, '/repo/sub', linux)).toBeUndefined()
  })

  it('keeps the workspace root when the cwd is unknown', () => {
    const folder = URI.file('/repo')
    expect(resolveSessionScopeRoot(folder, undefined, linux)).toEqual({
      root: folder,
      narrowed: false,
    })
  })

  it('keeps the workspace root for a root-level cwd', () => {
    const folder = URI.file('/repo')
    expect(resolveSessionScopeRoot(folder, '/repo', linux)).toEqual({
      root: folder,
      narrowed: false,
    })
  })

  it('narrows a strict subdirectory to its own root', () => {
    const folder = URI.file('/repo')
    const scope = resolveSessionScopeRoot(folder, '/repo/packages/app', linux)
    expect(scope?.root.toString()).toBe(URI.joinPath(folder, 'packages/app').toString())
    expect(scope?.narrowed).toBe(true)
  })

  it('ignores a trailing separator on the cwd', () => {
    const folder = URI.file('/repo')
    expect(resolveSessionScopeRoot(folder, '/repo/packages/app/', linux)?.narrowed).toBe(true)
  })

  it('does not treat a shared-prefix sibling as a subdirectory', () => {
    const folder = URI.file('/repo/packages/app')
    expect(resolveSessionScopeRoot(folder, '/repo/packages/app2', linux)).toEqual({
      root: folder,
      narrowed: false,
    })
  })

  it('falls back for a cwd outside the workspace', () => {
    const folder = URI.file('/repo')
    expect(resolveSessionScopeRoot(folder, '/elsewhere', linux)).toEqual({
      root: folder,
      narrowed: false,
    })
  })

  it('folds case on win32 and keeps the folder casing', () => {
    const folder = URI.file('D:\\Proj')
    const scope = resolveSessionScopeRoot(folder, 'd:/proj/Src', win32)
    expect(scope?.narrowed).toBe(true)
    expect(scope?.root.path).toBe('/D:/Proj/Src')
  })

  it('carries the folder scheme and authority into a remote subdirectory', () => {
    const folder = URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/ws' })
    const scope = resolveSessionScopeRoot(folder, '/ws/sub', linux)
    expect(scope?.root.toString()).toBe(`${REMOTE_SCHEME}://host/ws/sub`)
    expect(scope?.narrowed).toBe(true)
  })

  it('falls back to the workspace root without a uri identity service', () => {
    const folder = URI.file('/repo')
    expect(resolveSessionScopeRoot(folder, '/repo/sub', undefined)).toEqual({
      root: folder,
      narrowed: false,
    })
  })
})
