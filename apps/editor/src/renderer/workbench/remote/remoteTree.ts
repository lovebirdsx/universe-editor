/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  remoteTree — pure builder for the merged Remote Explorer "Targets" tree.
 *  Folds the three former data sources (SSH targets / WSL distros / live
 *  connections) plus remote-ssh recent workspaces into a group -> target ->
 *  recent structure. Component-free so it runs in the renderer-node test
 *  project; the view only renders + folds + wires events.
 *--------------------------------------------------------------------------------------------*/

import {
  REMOTE_SCHEME,
  WSL_AUTHORITY_PREFIX,
  isWslAuthority,
  normalizeRemoteAuthority,
  toDisplayPath,
  wslAuthorityForDistro,
  type IRecentWorkspace,
  type URI,
} from '@universe-editor/platform'
import type {
  RemoteConnectionStateDto,
  RemoteConnectionStatusDto,
  WslDistroDto,
} from '../../../shared/ipc/remoteStatusService.js'
import type { RemoteSshTarget } from '../../services/remote/RemoteExplorerService.js'

export type RemoteTargetKind = 'sshTarget' | 'wslTarget' | 'connection'

export interface RemoteTreeRecent {
  readonly folder: URI
  readonly label: string
  /** Remote parent directory (POSIX dirname of `folder.path`). */
  readonly description: string
  readonly lastOpened: number
}

export interface RemoteTreeTarget {
  readonly kind: RemoteTargetKind
  /** Canonical (normalized) authority — the row's identity + command argument. */
  readonly authority: string
  readonly label: string
  readonly state: RemoteConnectionStateDto | undefined
  readonly manual: boolean
  /** WSL only: the distro is the WSL default. */
  readonly isDefault?: boolean
  /** WSL only: the distro is currently running. */
  readonly isRunning?: boolean
  readonly recents: readonly RemoteTreeRecent[]
}

export interface RemoteTreeGroup {
  readonly id: 'ssh' | 'wsl'
  readonly targets: readonly RemoteTreeTarget[]
}

export interface RemoteTree {
  readonly groups: readonly RemoteTreeGroup[]
}

export interface BuildRemoteTreeInput {
  readonly sshTargets: readonly RemoteSshTarget[]
  readonly wslDistros: readonly WslDistroDto[]
  readonly connections: readonly RemoteConnectionStatusDto[]
  readonly recents: readonly IRecentWorkspace[]
}

/** Connections the old ConnectionsView surfaced: anything but idle/disposed. */
function isActiveConnection(state: RemoteConnectionStateDto): boolean {
  return state !== 'idle' && state !== 'disposed'
}

/** POSIX dirname of a remote folder path (`/a/b` -> `/a`, root stays `/`). */
function remoteParentPath(path: string): string {
  const segments = path.split('/').filter((s) => s !== '')
  if (segments.length <= 1) return '/'
  return `/${segments.slice(0, -1).join('/')}`
}

function wslDistroLabel(authority: string): string {
  return authority.slice(WSL_AUTHORITY_PREFIX.length)
}

export function buildRemoteTree(input: BuildRemoteTreeInput): RemoteTree {
  const { sshTargets, wslDistros, connections, recents } = input

  const connectionByAuthority = new Map<string, RemoteConnectionStateDto>()
  for (const c of connections) {
    connectionByAuthority.set(normalizeRemoteAuthority(c.authority), c.state)
  }

  const recentsByAuthority = new Map<string, RemoteTreeRecent[]>()
  for (const entry of recents) {
    if (entry.folder.scheme !== REMOTE_SCHEME) continue
    const authority = normalizeRemoteAuthority(entry.folder.authority)
    const row: RemoteTreeRecent = {
      folder: entry.folder,
      label: entry.name,
      description: toDisplayPath(remoteParentPath(entry.folder.path)),
      lastOpened: entry.lastOpened,
    }
    const list = recentsByAuthority.get(authority)
    if (list) list.push(row)
    else recentsByAuthority.set(authority, [row])
  }

  const recentsFor = (authority: string): readonly RemoteTreeRecent[] => {
    const list = recentsByAuthority.get(authority)
    if (!list || list.length === 0) return []
    return [...list].sort((a, b) => b.lastOpened - a.lastOpened || a.label.localeCompare(b.label))
  }

  const sshTargetRows: RemoteTreeTarget[] = []
  const wslTargetRows: RemoteTreeTarget[] = []
  const covered = new Set<string>()

  for (const t of sshTargets) {
    const authority = normalizeRemoteAuthority(t.host)
    covered.add(authority)
    sshTargetRows.push({
      kind: 'sshTarget',
      authority,
      label: t.host,
      state: connectionByAuthority.get(authority),
      manual: t.manual,
      recents: recentsFor(authority),
    })
  }

  for (const d of wslDistros) {
    const authority = wslAuthorityForDistro(d.name)
    covered.add(authority)
    wslTargetRows.push({
      kind: 'wslTarget',
      authority,
      label: d.name,
      state: connectionByAuthority.get(authority),
      manual: false,
      ...(d.isDefault ? { isDefault: true } : {}),
      ...(d.isRunning ? { isRunning: true } : {}),
      recents: recentsFor(authority),
    })
  }

  // Synthesize a target for authorities known only via an active connection or
  // a remote recent workspace (so the old Connections view loses nothing, incl.
  // E2E direct-mode authorities).
  const syntheticAuthorities = new Set<string>()
  for (const authority of connectionByAuthority.keys()) {
    const state = connectionByAuthority.get(authority)
    if (state !== undefined && isActiveConnection(state)) syntheticAuthorities.add(authority)
  }
  for (const authority of recentsByAuthority.keys()) syntheticAuthorities.add(authority)

  for (const authority of syntheticAuthorities) {
    if (covered.has(authority)) continue
    const state = connectionByAuthority.get(authority)
    const hasActive = state !== undefined && isActiveConnection(state)
    const hasRecents = (recentsByAuthority.get(authority)?.length ?? 0) > 0
    if (!hasActive && !hasRecents) continue
    const wsl = isWslAuthority(authority)
    const kind: RemoteTargetKind = hasActive ? 'connection' : wsl ? 'wslTarget' : 'sshTarget'
    const target: RemoteTreeTarget = {
      kind,
      authority,
      label: wsl ? wslDistroLabel(authority) : authority,
      state,
      manual: false,
      recents: recentsFor(authority),
    }
    if (wsl) wslTargetRows.push(target)
    else sshTargetRows.push(target)
  }

  sshTargetRows.sort((a, b) => a.label.localeCompare(b.label))
  wslTargetRows.sort((a, b) => a.label.localeCompare(b.label))

  return {
    groups: [
      { id: 'ssh', targets: sshTargetRows },
      { id: 'wsl', targets: wslTargetRows },
    ],
  }
}
