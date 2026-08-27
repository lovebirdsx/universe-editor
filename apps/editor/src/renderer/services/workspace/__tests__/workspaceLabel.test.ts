import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { workspaceFullLabel, workspaceParentLabel, workspaceTitleLabel } from '../workspaceLabel.js'

const REMOTE_FOLDER = URI.from({
  scheme: 'remote-ssh',
  authority: 'wsl+ubuntu-24.04',
  path: '/home/x/proj',
})

const WINDOWS_REMOTE_FOLDER = URI.from({
  scheme: 'remote-ssh',
  authority: 'ssh+192.0.2.20',
  path: '/E:/workspace/universe-editor.worktrees/task1',
})

describe('workspaceTitleLabel', () => {
  it('returns the local fsPath for file folders', () => {
    const folder = URI.file('/tmp/myProject')
    expect(workspaceTitleLabel(folder)).toBe(folder.fsPath)
  })

  it('returns the server-side path for remote folders (no scheme/authority)', () => {
    expect(workspaceTitleLabel(REMOTE_FOLDER)).toBe('/home/x/proj')
  })

  it('renders a Windows remote path in native drive form', () => {
    expect(workspaceTitleLabel(WINDOWS_REMOTE_FOLDER)).toBe(
      'E:\\workspace\\universe-editor.worktrees\\task1',
    )
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

  it('renders a Windows remote parent in native drive form', () => {
    expect(workspaceParentLabel(WINDOWS_REMOTE_FOLDER)).toBe(
      'E:\\workspace\\universe-editor.worktrees',
    )
  })

  it('renders a Windows remote drive root as `E:\\`', () => {
    const driveRoot = URI.from({
      scheme: 'remote-ssh',
      authority: 'ssh+192.0.2.20',
      path: '/E:/proj',
    })
    expect(workspaceParentLabel(driveRoot)).toBe('E:\\')
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

  it('keeps the full scheme-qualified URI for a Windows remote folder', () => {
    expect(workspaceFullLabel(WINDOWS_REMOTE_FOLDER)).toBe(WINDOWS_REMOTE_FOLDER.toString())
  })
})
