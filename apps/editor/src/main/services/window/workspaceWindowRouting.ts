/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace → window routing shared by every main-side consumer that needs a live
 *  renderer bridge for a folder (mobile gateway, agent triggers). Keeping the
 *  workspace identity rule and the wait loop in one place stops the two features
 *  from drifting apart on casing / separators or poll cadence.
 *--------------------------------------------------------------------------------------------*/

import {
  arePathsEqual,
  normalizePlatform,
  URI,
  type IOpenWindowInfo,
} from '@universe-editor/platform'

export interface WorkspaceWindowCandidate {
  readonly windowId: number
  /** URI string (`file:///...`), the same shape the bridges and hub exchange. */
  readonly folder: string
  readonly name: string
  readonly authority?: string
}

const HOST_PLATFORM = normalizePlatform(process.platform)

export const DEFAULT_HOST_WAIT_POLL_MS = 100

/** Open windows that actually hold a folder, in the order the window service reports them. */
export function listWorkspaceWindows(
  infos: readonly IOpenWindowInfo[],
): readonly WorkspaceWindowCandidate[] {
  const result: WorkspaceWindowCandidate[] = []
  for (const info of infos) {
    if (info.folder === null) continue
    const folder = URI.from(info.folder)
    result.push({
      windowId: info.id,
      folder: folder.toString(),
      name: info.name ?? folder.fsPath,
      ...(info.remoteAuthority !== undefined
        ? { authority: info.remoteAuthority }
        : folder.authority
          ? { authority: folder.authority }
          : {}),
    })
  }
  return result
}

export function isSameWorkspace(
  a: { readonly folder: string; readonly authority?: string },
  b: { readonly folder: string; readonly authority?: string },
): boolean {
  let first: URI
  let second: URI
  try {
    first = URI.parse(a.folder)
    second = URI.parse(b.folder)
  } catch {
    return a.folder === b.folder
  }
  if (first.scheme !== second.scheme) return false
  if ((a.authority ?? first.authority) !== (b.authority ?? second.authority)) return false
  return arePathsEqual(first.fsPath, second.fsPath, HOST_PLATFORM)
}

export interface WorkspaceHostDirectory {
  readonly listOpenWorkspaces: () => readonly WorkspaceWindowCandidate[]
  readonly hasHost: (windowId: number) => boolean
}

export interface WorkspaceHostTarget {
  readonly folder: string
  readonly authority?: string
}

/** Synchronous probe: the first open window at `target` that has a live host. */
export function findWorkspaceHost(
  directory: WorkspaceHostDirectory,
  target: WorkspaceHostTarget,
): number | undefined {
  for (const workspace of directory.listOpenWorkspaces()) {
    if (!isSameWorkspace(workspace, target)) continue
    if (directory.hasHost(workspace.windowId)) return workspace.windowId
  }
  return undefined
}

export interface WaitForWorkspaceHostOptions {
  readonly target: WorkspaceHostTarget
  readonly timeoutMs: number
  readonly pollIntervalMs?: number
  /** Injected in tests; the wait loop must not touch the wall clock otherwise. */
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Polls until a window at `target` registers its host. Returns `undefined` when
 * the deadline passes; the caller decides whether that is a failure.
 */
export async function waitForWorkspaceHost(
  directory: WorkspaceHostDirectory,
  options: WaitForWorkspaceHostOptions,
): Promise<number | undefined> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const interval = Math.max(10, options.pollIntervalMs ?? DEFAULT_HOST_WAIT_POLL_MS)
  const deadline = now() + Math.max(0, options.timeoutMs)
  for (;;) {
    const match = findWorkspaceHost(directory, options.target)
    if (match !== undefined) return match
    if (now() >= deadline) return undefined
    await sleep(Math.min(interval, Math.max(0, deadline - now())))
  }
}
