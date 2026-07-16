/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/workspace/workspaceTrust.ts — parent-prefix
 *  inheritance, default-untrusted folders, grant/revoke, persistence, participants.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { URI } from '../../base/uri.js'
import { Emitter, Event } from '../../base/event.js'
import { UriIdentityService } from '../../uriIdentity/uriIdentityService.js'
import { type IStorageService } from '../../storage/storageService.js'
import type { IWorkspace, IWorkspaceService } from '../../workspace/workspaceService.js'
import {
  WORKSPACE_TRUST_STORAGE_KEY,
  WorkspaceTrustManagementService,
} from '../../workspace/workspaceTrust.js'

function fakeStorage(): IStorageService & { dump(): Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    _serviceBrand: undefined,
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    set: (key: string, value: unknown) => {
      map.set(key, value)
      return Promise.resolve()
    },
    remove: (key: string) => {
      map.delete(key)
      return Promise.resolve()
    },
    onDidChangeWorkspaceScope: Event.None,
    dump: () => map,
  } as unknown as IStorageService & { dump(): Map<string, unknown> }
}

function fakeWorkspace(folder: URI | null): IWorkspaceService & {
  change(next: URI | null): void
} {
  const onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  let current: IWorkspace | null = folder ? { folder, name: 'ws' } : null
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: onDidChangeWorkspace.event,
    recent: [],
    onDidChangeRecent: Event.None,
    whenReady: Promise.resolve(),
    openFolder: () => Promise.resolve(),
    closeFolder: () => Promise.resolve(),
    removeRecent: () => Promise.resolve(),
    clearRecent: () => Promise.resolve(),
    change: (next: URI | null) => {
      current = next ? { folder: next, name: 'ws' } : null
      onDidChangeWorkspace.fire(current)
    },
  } as unknown as IWorkspaceService & { change(next: URI | null): void }
}

function make(folder: URI | null, storage = fakeStorage()) {
  const ws = fakeWorkspace(folder)
  const svc = new WorkspaceTrustManagementService(storage, ws, new UriIdentityService('linux'))
  return { svc, ws, storage }
}

describe('WorkspaceTrustManagementService', () => {
  it('a folder workspace is untrusted by default', async () => {
    const { svc } = make(URI.file('/proj'))
    await svc.workspaceTrustInitialized
    expect(svc.isWorkspaceTrusted()).toBe(false)
  })

  it('an empty window (no folder) is trusted', async () => {
    const { svc } = make(null)
    await svc.workspaceTrustInitialized
    expect(svc.isWorkspaceTrusted()).toBe(true)
    expect(svc.canSetWorkspaceTrust()).toBe(false)
  })

  it('granting trust flips isWorkspaceTrusted and fires onDidChangeTrust', async () => {
    const { svc } = make(URI.file('/proj'))
    await svc.workspaceTrustInitialized
    const changes: boolean[] = []
    svc.onDidChangeTrust((t) => changes.push(t))

    await svc.setWorkspaceTrust(true)
    expect(svc.isWorkspaceTrusted()).toBe(true)
    expect(changes).toEqual([true])
  })

  it('trust is inherited by nested folders (deepest ancestor match)', async () => {
    const { svc } = make(URI.file('/proj/app'))
    await svc.workspaceTrustInitialized
    await svc.setUrisTrust([URI.file('/proj')], true)
    // The open folder /proj/app nests under the trusted /proj.
    expect(svc.isWorkspaceTrusted()).toBe(true)
    expect(svc.getUriTrustInfo(URI.file('/proj/app/src')).trusted).toBe(true)
    expect(svc.getUriTrustInfo(URI.file('/other')).trusted).toBe(false)
  })

  it('a sibling sharing a name prefix is not trusted', async () => {
    const { svc } = make(URI.file('/proj-secret'))
    await svc.workspaceTrustInitialized
    await svc.setUrisTrust([URI.file('/proj')], true)
    expect(svc.getUriTrustInfo(URI.file('/proj-secret')).trusted).toBe(false)
  })

  it('deepest match wins when nested entries disagree in specificity', async () => {
    const { svc } = make(null)
    await svc.workspaceTrustInitialized
    await svc.setUrisTrust([URI.file('/a')], true)
    expect(svc.getUriTrustInfo(URI.file('/a/b/c')).uri.fsPath).toBe('/a')
    await svc.setUrisTrust([URI.file('/a/b')], true)
    expect(svc.getUriTrustInfo(URI.file('/a/b/c')).uri.fsPath).toBe('/a/b')
  })

  it('revoking trust removes the entry and flips back to untrusted', async () => {
    const { svc } = make(URI.file('/proj'))
    await svc.workspaceTrustInitialized
    await svc.setWorkspaceTrust(true)
    expect(svc.isWorkspaceTrusted()).toBe(true)

    await svc.setWorkspaceTrust(false)
    expect(svc.isWorkspaceTrusted()).toBe(false)
    expect(svc.getTrustedUris()).toHaveLength(0)
  })

  it('persists trusted uris and rehydrates them (only trusted entries survive)', async () => {
    const storage = fakeStorage()
    const first = make(URI.file('/proj'), storage)
    await first.svc.workspaceTrustInitialized
    await first.svc.setWorkspaceTrust(true)

    // A fresh service over the same storage sees the folder as trusted.
    const second = make(URI.file('/proj'), storage)
    await second.svc.workspaceTrustInitialized
    expect(second.svc.isWorkspaceTrusted()).toBe(true)
    expect(second.svc.getTrustedUris().map((u) => u.fsPath)).toEqual(['/proj'])

    const stored = storage.dump().get(WORKSPACE_TRUST_STORAGE_KEY)
    expect(stored).toBeDefined()
  })

  it('setTrustedUris replaces the whole list and dedupes', async () => {
    const { svc } = make(null)
    await svc.workspaceTrustInitialized
    await svc.setTrustedUris([URI.file('/a'), URI.file('/a'), URI.file('/b')])
    expect(
      svc
        .getTrustedUris()
        .map((u) => u.fsPath)
        .sort(),
    ).toEqual(['/a', '/b'])
  })

  it('recomputes trust when the workspace folder changes', async () => {
    const { svc, ws } = make(URI.file('/untrusted'))
    await svc.workspaceTrustInitialized
    await svc.setUrisTrust([URI.file('/trusted')], true)
    expect(svc.isWorkspaceTrusted()).toBe(false)

    ws.change(URI.file('/trusted/sub'))
    await Promise.resolve()
    await Promise.resolve()
    expect(svc.isWorkspaceTrusted()).toBe(true)
  })

  it('runs transition participants on trust change', async () => {
    const { svc } = make(URI.file('/proj'))
    await svc.workspaceTrustInitialized
    const participate = vi.fn().mockResolvedValue(undefined)
    svc.addWorkspaceTrustTransitionParticipant({ participate })

    await svc.setWorkspaceTrust(true)
    expect(participate).toHaveBeenCalledWith(true)
  })

  it('query/fragment are stripped from stored trust uris', async () => {
    const { svc } = make(null)
    await svc.workspaceTrustInitialized
    await svc.setUrisTrust([URI.file('/proj').with({ query: 'x', fragment: 'y' })], true)
    const [uri] = svc.getTrustedUris()
    expect(uri?.query).toBe('')
    expect(uri?.fragment).toBe('')
  })
})
