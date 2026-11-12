import { URI } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import { isPathWithinWorkspace } from '../workspacePathScope.js'

describe('isPathWithinWorkspace', () => {
  it('compares remote paths with POSIX semantics', () => {
    const root = URI.parse('remote-ssh://host/work')
    expect(isPathWithinWorkspace(root, URI.parse('remote-ssh://host/work/sub'), 'win32')).toBe(true)
    expect(isPathWithinWorkspace(root, URI.parse('remote-ssh://host/work'), 'win32')).toBe(true)
    expect(isPathWithinWorkspace(root, URI.parse('remote-ssh://host/workspace'), 'win32')).toBe(
      false,
    )
    expect(isPathWithinWorkspace(root, URI.parse('remote-ssh://other/work/sub'), 'win32')).toBe(
      false,
    )
  })

  it('uses the host platform for local paths', () => {
    const root = URI.parse('file:///C:/Work')
    expect(isPathWithinWorkspace(root, URI.parse('file:///c:/work/sub'), 'win32')).toBe(true)
    expect(isPathWithinWorkspace(root, URI.parse('file:///c:/work/sub'), 'linux')).toBe(false)
    expect(isPathWithinWorkspace(root, URI.parse('file:///D:/Work/sub'), 'win32')).toBe(false)
  })

  it('keeps UNC shares separated by authority', () => {
    const root = URI.parse('file://server/share')
    expect(isPathWithinWorkspace(root, URI.parse('file://server/share/sub'), 'win32')).toBe(true)
    expect(isPathWithinWorkspace(root, URI.parse('file://other/share/sub'), 'win32')).toBe(false)
  })

  it('treats the POSIX root as containing every path on the same scheme/authority', () => {
    expect(isPathWithinWorkspace(URI.parse('file:///'), URI.parse('file:///work/sub'), 'linux')).toBe(
      true,
    )
    expect(
      isPathWithinWorkspace(
        URI.parse('remote-ssh://host/'),
        URI.parse('remote-ssh://host/home/dev'),
        'win32',
      ),
    ).toBe(true)
    expect(
      isPathWithinWorkspace(
        URI.parse('remote-ssh://host/'),
        URI.parse('remote-ssh://other/home/dev'),
        'win32',
      ),
    ).toBe(false)
  })

  it('rejects a different scheme even with the same path', () => {
    expect(
      isPathWithinWorkspace(
        URI.parse('file:///work'),
        URI.parse('remote-ssh://host/work'),
        'linux',
      ),
    ).toBe(false)
  })
})
