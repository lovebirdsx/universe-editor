/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/workspace/folderOpenGuard.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  classifyFolderProbeError,
  probeLocalWorkspaceFolder,
  shouldRemoveRecent,
  type FolderStat,
} from '../folderOpenGuard.js'

function statOf(isDirectory: boolean): FolderStat {
  return async () => ({ isDirectory: () => isDirectory })
}

function failingStat(code?: string): FolderStat {
  return async () => {
    const err = new Error(code ?? 'boom') as NodeJS.ErrnoException
    if (code !== undefined) err.code = code
    throw err
  }
}

describe('probeLocalWorkspaceFolder', () => {
  const folder = URI.file('/tmp/workspace')

  it('accepts a directory', async () => {
    await expect(probeLocalWorkspaceFolder(folder, statOf(true))).resolves.toBeNull()
  })

  it('rejects an existing non-directory', async () => {
    await expect(probeLocalWorkspaceFolder(folder, statOf(false))).resolves.toEqual({
      problem: 'not-a-directory',
    })
  })

  it.each(['ENOENT', 'ENOTDIR'])('classifies %s as not-found', async (code) => {
    const failure = await probeLocalWorkspaceFolder(folder, failingStat(code))
    expect(failure?.problem).toBe('not-found')
    expect((failure?.error as NodeJS.ErrnoException).code).toBe(code)
  })

  it.each(['EACCES', 'EPERM', 'EIO', undefined])('classifies %s as unavailable', async (code) => {
    const failure = await probeLocalWorkspaceFolder(folder, failingStat(code))
    expect(failure?.problem).toBe('unavailable')
  })

  it('passes the folder fsPath to stat', async () => {
    const stat = vi.fn(statOf(true))
    await probeLocalWorkspaceFolder(folder, stat)
    expect(stat).toHaveBeenCalledWith(folder.fsPath)
  })

  it('never probes non-file URIs', async () => {
    const stat = vi.fn(statOf(true))
    const remote = URI.parse('remote-ssh://e2e-local/home/dev/project')
    await expect(probeLocalWorkspaceFolder(remote, stat)).resolves.toBeNull()
    expect(stat).not.toHaveBeenCalled()
  })
})

describe('classifyFolderProbeError', () => {
  it('treats ENOENT and ENOTDIR as not-found', () => {
    expect(classifyFolderProbeError({ code: 'ENOENT' })).toBe('not-found')
    expect(classifyFolderProbeError({ code: 'ENOTDIR' })).toBe('not-found')
  })

  it('treats everything else as unavailable', () => {
    expect(classifyFolderProbeError({ code: 'EACCES' })).toBe('unavailable')
    expect(classifyFolderProbeError(new Error('boom'))).toBe('unavailable')
    expect(classifyFolderProbeError(null)).toBe('unavailable')
  })
})

describe('shouldRemoveRecent', () => {
  it('removes missing and non-directory entries but keeps unavailable ones', () => {
    expect(shouldRemoveRecent({ problem: 'not-found' })).toBe(true)
    expect(shouldRemoveRecent({ problem: 'not-a-directory' })).toBe(true)
    expect(shouldRemoveRecent({ problem: 'unavailable' })).toBe(false)
  })
})
