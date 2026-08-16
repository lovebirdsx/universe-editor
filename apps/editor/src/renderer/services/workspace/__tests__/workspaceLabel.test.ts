import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { workspaceFullLabel, workspaceParentLabel, workspaceTitleLabel } from '../workspaceLabel.js'

const REMOTE_FOLDER = URI.from({
  scheme: 'remote-ssh',
  authority: 'wsl+ubuntu-24.04',
  path: '/home/x/proj',
})

describe('workspaceTitleLabel', () => {
  it('returns the local fsPath for file folders', () => {
    const folder = URI.file('/tmp/myProject')
    expect(workspaceTitleLabel(folder)).toBe(folder.fsPath)
  })

  it('returns the server-side path for remote folders (no scheme/authority)', () => {
    expect(workspaceTitleLabel(REMOTE_FOLDER)).toBe('/home/x/proj')
  })
})

describe('workspaceParentLabel', () => {
  it('returns the local parent fsPath for file folders', () => {
    const folder = URI.file('/tmp/myProject')
    expect(workspaceParentLabel(folder)).toBe(URI.file('/tmp').fsPath)
  })

  it('returns the server-side parent path for remote folders', () => {
    expect(workspaceParentLabel(REMOTE_FOLDER)).toBe('/home/x')
  })

  it('falls back to the server root when the remote folder sits at "/"', () => {
    const rootFolder = URI.from({
      scheme: 'remote-ssh',
      authority: 'wsl+ubuntu-24.04',
      path: '/proj',
    })
    expect(workspaceParentLabel(rootFolder)).toBe('/')
  })
})

describe('workspaceFullLabel', () => {
  it('returns the local fsPath for file folders', () => {
    const folder = URI.file('/tmp/myProject')
    expect(workspaceFullLabel(folder)).toBe(folder.fsPath)
  })

  it('returns the full scheme-qualified URI for remote folders', () => {
    expect(workspaceFullLabel(REMOTE_FOLDER)).toBe(REMOTE_FOLDER.toString())
  })
})
