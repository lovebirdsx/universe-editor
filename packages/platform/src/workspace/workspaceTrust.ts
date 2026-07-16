/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace Trust — ported from VSCode's IWorkspaceTrustManagementService
 *  (workbench/services/workspaces/common/workspaceTrust.ts). Single-folder,
 *  local `file://` only: the remote / virtual-resource / empty-workspace-memento
 *  branches are intentionally dropped.
 *
 *  Trust is stored application-wide (a machine's trusted-folder list, not
 *  per-workspace) as a list of trusted directory URIs. A folder is trusted when
 *  it equals or nests under a stored trusted URI (deepest match wins). A folder
 *  workspace is untrusted by default until the user grants it; an empty window
 *  (no folder) is trusted (nothing to distrust).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { Emitter } from '../base/event.js'
import { Disposable, type IDisposable, toDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'
import { URI, type UriComponents } from '../base/uri.js'
import { IStorageService, StorageScope } from '../storage/storageService.js'
import { IUriIdentityService } from '../uriIdentity/uriIdentityService.js'
import { IWorkspaceService } from './workspaceService.js'

/** Storage key mirrors VSCode's so the semantics are recognizable. */
export const WORKSPACE_TRUST_STORAGE_KEY = 'content.trust.model.key'

export interface IWorkspaceTrustUriInfo {
  readonly uri: URI
  readonly trusted: boolean
}

export interface IWorkspaceTrustInfo {
  uriTrustInfo: IWorkspaceTrustUriInfo[]
}

/** Runs when trust flips (grant/revoke); a revoke participant restarts the host. */
export interface IWorkspaceTrustTransitionParticipant {
  participate(trusted: boolean): Promise<void>
}

export interface IWorkspaceTrustManagementService {
  readonly _serviceBrand: undefined

  /** Fires with the new trusted state whenever it flips. */
  readonly onDidChangeTrust: Event<boolean>
  /** Fires when the stored trusted-folder list changes (may not flip current trust). */
  readonly onDidChangeTrustedFolders: Event<void>

  /** Resolves once the initial storage load + first trust computation has settled. */
  readonly workspaceTrustInitialized: Promise<void>

  isWorkspaceTrusted(): boolean
  /** False when there's no folder to grant trust to (empty window). */
  canSetWorkspaceTrust(): boolean
  /** Grant/revoke trust for the current workspace folder(s). */
  setWorkspaceTrust(trusted: boolean): Promise<void>

  /** Trust info for an arbitrary URI (deepest stored-ancestor match). */
  getUriTrustInfo(uri: URI): IWorkspaceTrustUriInfo
  /** Add/remove specific URIs from the trusted list. */
  setUrisTrust(uris: URI[], trusted: boolean): Promise<void>

  getTrustedUris(): URI[]
  /** Replace the whole trusted list. */
  setTrustedUris(uris: URI[]): Promise<void>

  addWorkspaceTrustTransitionParticipant(
    participant: IWorkspaceTrustTransitionParticipant,
  ): IDisposable
}

export const IWorkspaceTrustManagementService = createDecorator<IWorkspaceTrustManagementService>(
  'workspaceTrustManagementService',
)

interface StoredTrustInfo {
  uriTrustInfo?: { uri: UriComponents; trusted?: boolean }[]
}

export class WorkspaceTrustManagementService
  extends Disposable
  implements IWorkspaceTrustManagementService
{
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeTrust = this._register(new Emitter<boolean>())
  readonly onDidChangeTrust = this._onDidChangeTrust.event

  private readonly _onDidChangeTrustedFolders = this._register(new Emitter<void>())
  readonly onDidChangeTrustedFolders = this._onDidChangeTrustedFolders.event

  private _trustStateInfo: IWorkspaceTrustInfo = { uriTrustInfo: [] }
  private _isTrusted = false
  private readonly _participants: IWorkspaceTrustTransitionParticipant[] = []

  readonly workspaceTrustInitialized: Promise<void>

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
  ) {
    super()
    this.workspaceTrustInitialized = this._initialize()
    this._register(
      this._workspace.onDidChangeWorkspace(() => {
        void this._updateWorkspaceTrust()
      }),
    )
  }

  private async _initialize(): Promise<void> {
    await this._workspace.whenReady
    this._trustStateInfo = await this._loadTrustInfo()
    this._isTrusted = this._calculateWorkspaceTrust()
  }

  isWorkspaceTrusted(): boolean {
    return this._isTrusted
  }

  canSetWorkspaceTrust(): boolean {
    return this._workspaceUris().length > 0
  }

  async setWorkspaceTrust(trusted: boolean): Promise<void> {
    const uris = this._workspaceUris()
    if (uris.length === 0) return
    await this.setUrisTrust(uris, trusted)
  }

  getUriTrustInfo(uri: URI): IWorkspaceTrustUriInfo {
    return this._doGetUriTrustInfo(this._canonical(uri))
  }

  async setUrisTrust(uris: URI[], trusted: boolean): Promise<void> {
    let changed = false
    for (const raw of uris) {
      const uri = this._canonical(raw)
      if (trusted) {
        const found = this._trustStateInfo.uriTrustInfo.find((info) =>
          this._uriIdentity.isEqual(info.uri, uri),
        )
        if (!found) {
          this._trustStateInfo.uriTrustInfo.push({ uri, trusted: true })
          changed = true
        }
      } else {
        const before = this._trustStateInfo.uriTrustInfo.length
        this._trustStateInfo.uriTrustInfo = this._trustStateInfo.uriTrustInfo.filter(
          (info) => !this._uriIdentity.isEqual(info.uri, uri),
        )
        if (before !== this._trustStateInfo.uriTrustInfo.length) changed = true
      }
    }
    if (changed) await this._saveTrustInfo()
  }

  getTrustedUris(): URI[] {
    return this._trustStateInfo.uriTrustInfo.map((info) => info.uri)
  }

  async setTrustedUris(uris: URI[]): Promise<void> {
    const next: IWorkspaceTrustUriInfo[] = []
    for (const raw of uris) {
      const uri = this._canonical(raw)
      if (next.some((info) => this._uriIdentity.isEqual(info.uri, uri))) continue
      next.push({ uri, trusted: true })
    }
    this._trustStateInfo.uriTrustInfo = next
    await this._saveTrustInfo()
  }

  addWorkspaceTrustTransitionParticipant(
    participant: IWorkspaceTrustTransitionParticipant,
  ): IDisposable {
    this._participants.push(participant)
    return toDisposable(() => {
      const idx = this._participants.indexOf(participant)
      if (idx !== -1) this._participants.splice(idx, 1)
    })
  }

  // --- internals ----------------------------------------------------------

  /** Query/fragment carry no identity for a trusted folder. */
  private _canonical(uri: URI): URI {
    return uri.with({ query: null, fragment: null })
  }

  private _workspaceUris(): URI[] {
    const folder = this._workspace.current?.folder
    return folder ? [folder] : []
  }

  /** VSCode `doGetUriTrustInfo`: deepest stored-ancestor match wins. */
  private _doGetUriTrustInfo(uri: URI): IWorkspaceTrustUriInfo {
    let resultState = false
    let maxLength = -1
    let resultUri = uri
    for (const trustInfo of this._trustStateInfo.uriTrustInfo) {
      if (this._uriIdentity.isEqualOrParent(uri, trustInfo.uri)) {
        const fsPath = trustInfo.uri.fsPath
        if (fsPath.length > maxLength) {
          maxLength = fsPath.length
          resultState = trustInfo.trusted
          resultUri = trustInfo.uri
        }
      }
    }
    return { trusted: resultState, uri: resultUri }
  }

  /** Trusted iff every workspace folder is trusted; empty window is trusted. */
  private _calculateWorkspaceTrust(): boolean {
    const uris = this._workspaceUris()
    if (uris.length === 0) return true
    for (const uri of uris) {
      if (!this._doGetUriTrustInfo(uri).trusted) return false
    }
    return true
  }

  private async _updateWorkspaceTrust(): Promise<void> {
    const trusted = this._calculateWorkspaceTrust()
    if (this._isTrusted === trusted) return
    this._isTrusted = trusted
    for (const participant of this._participants) {
      await participant.participate(trusted)
    }
    this._onDidChangeTrust.fire(trusted)
  }

  private async _loadTrustInfo(): Promise<IWorkspaceTrustInfo> {
    const stored = await this._storage.get<StoredTrustInfo>(
      WORKSPACE_TRUST_STORAGE_KEY,
      StorageScope.GLOBAL,
    )
    const raw = stored?.uriTrustInfo ?? []
    const uriTrustInfo: IWorkspaceTrustUriInfo[] = []
    for (const info of raw) {
      if (info.trusted !== true) continue
      const uri = URI.revive(info.uri)
      if (uri) uriTrustInfo.push({ uri, trusted: true })
    }
    return { uriTrustInfo }
  }

  private async _saveTrustInfo(): Promise<void> {
    const serialized: StoredTrustInfo = {
      uriTrustInfo: this._trustStateInfo.uriTrustInfo.map((info) => ({
        uri: info.uri.toJSON() as UriComponents,
        trusted: info.trusted,
      })),
    }
    await this._storage.set(WORKSPACE_TRUST_STORAGE_KEY, serialized, StorageScope.GLOBAL)
    this._onDidChangeTrustedFolders.fire()
    await this._updateWorkspaceTrust()
  }
}
