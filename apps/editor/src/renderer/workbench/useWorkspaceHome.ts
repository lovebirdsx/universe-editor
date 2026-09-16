/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useWorkspaceHome — the home directory of the host `contextUri` (or the current
 *  workspace folder) lives on, for expanding a leading `~`.
 *
 *  `~` is host-relative. In a remote-ssh workspace the path was written by a
 *  process running on the remote host (the agent that produced
 *  `~/.claude/plans/x.md` is spawned there), so expanding it against the preload
 *  bridge's os.homedir() names a file on the client's disk and the click reports
 *  a file that exists nowhere. The authority therefore comes from `contextUri`
 *  first — the markdown source dir / workspace folder, i.e. the very URI whose
 *  scheme/authority the resolved candidate inherits — then from the current
 *  workspace folder. The window's argv authority is deliberately not consulted:
 *  a pty/agent only goes remote once a remote folder is open, so an empty remote
 *  window stays local.
 *
 *  Workspace hydration is a cross-process roundtrip (see useRemoteAuthority) and
 *  the remote home only arrives with the handshake, so the authority is
 *  subscribed to rather than memoized, and a click handler must await
 *  `resolveHome()` instead of reading a possibly-stale `home`.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Event, IWorkspaceService, markAsSingleton, type URI } from '@universe-editor/platform'
import { IRemoteStatusService } from '../../shared/ipc/remoteStatusService.js'
import { remoteAuthorityFromWorkspace } from '../services/remote/windowRemoteAuthority.js'
import { useEventValue, useOptionalService } from './useService.js'

export interface WorkspaceHome {
  /**
   * Home of the host the context lives on. Undefined while a remote authority's
   * environment is unknown — never the client's home, which would name a file on
   * the wrong machine.
   */
  readonly home: string | undefined
  /** Await the home at click time: the handshake may not have delivered it yet. */
  readonly resolveHome: () => Promise<string | undefined>
}

interface RemoteHome {
  readonly authority: string
  readonly home: string | undefined
}

/** os.homedir() of the client machine, injected by main via `--ue-home-dir=`. */
function clientHome(): string | undefined {
  const ipc = typeof window !== 'undefined' ? window.ipc : undefined
  return typeof ipc?.home === 'string' && ipc.home.length > 0 ? ipc.home : undefined
}

export function useWorkspaceHome(contextUri?: URI): WorkspaceHome {
  const workspace = useOptionalService(IWorkspaceService)
  const remoteStatus = useOptionalService(IRemoteStatusService)

  const contextAuthority = contextUri
    ? remoteAuthorityFromWorkspace({ folder: contextUri })
    : undefined
  const getWorkspaceAuthority = useCallback(
    () => remoteAuthorityFromWorkspace(workspace?.current),
    [workspace],
  )
  const workspaceAuthority = useEventValue(
    workspace?.onDidChangeWorkspace ?? Event.None,
    getWorkspaceAuthority,
  )
  const authority = contextAuthority ?? workspaceAuthority

  const [remote, setRemote] = useState<RemoteHome>()

  useEffect(() => {
    if (!authority || !remoteStatus) return
    let cancelled = false
    const load = (): void => {
      void remoteStatus.getEnvironment(authority).then((env) => {
        if (!cancelled) setRemote({ authority, home: env?.homeDir })
      })
    }
    load()
    const sub = markAsSingleton(
      remoteStatus.onDidChangeState((status) => {
        // Re-read on (re)connect: a mid-reconnect authority reports no
        // environment, and caching that answer would outlive the reconnect.
        if (status.authority === authority && status.state === 'connected') load()
      }),
    )
    return () => {
      cancelled = true
      sub.dispose()
    }
  }, [authority, remoteStatus])

  // A home fetched for another authority must never expand this context's `~`.
  const remoteHome = remote && remote.authority === authority ? remote.home : undefined
  // No service to ask (degraded container / unit test) leaves the client home as
  // the only one we can name.
  const home = authority && remoteStatus ? remoteHome : clientHome()

  const resolveHome = useCallback(async (): Promise<string | undefined> => {
    if (!authority || !remoteStatus) return clientHome()
    const env = await remoteStatus.getEnvironment(authority).catch(() => null)
    return env?.homeDir
  }, [authority, remoteStatus])

  return useMemo(() => ({ home, resolveHome }), [home, resolveHome])
}
