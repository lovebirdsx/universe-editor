import { useEffect, useState } from 'react'
import { IWorkspaceService, REMOTE_SCHEME, markAsSingleton } from '@universe-editor/platform'
import { useService } from '../../useService.js'
import { IRemoteStatusService } from '../../../../shared/ipc/remoteStatusService.js'

function localHome(): string | undefined {
  const ipc = typeof window !== 'undefined' ? window.ipc : undefined
  return typeof ipc?.home === 'string' && ipc.home.length > 0 ? ipc.home : undefined
}

// remote 工作区的 pty 在远端 spawn，`~` 须展开为远端 POSIX home（本地工作区则用本机 home）。
export function useTerminalHome(): string | undefined {
  const workspace = useService(IWorkspaceService)
  const remoteStatus = useService(IRemoteStatusService)
  const folder = workspace.current?.folder
  const authority = folder?.scheme === REMOTE_SCHEME ? folder.authority : undefined

  const [home, setHome] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!authority) return
    let cancelled = false
    void remoteStatus.getEnvironment(authority).then((env) => {
      if (!cancelled && env) setHome(env.homeDir)
    })
    const sub = markAsSingleton(
      remoteStatus.onDidChangeState((status) => {
        if (status.authority === authority && status.state === 'connected') {
          void remoteStatus.getEnvironment(authority).then((env) => {
            if (!cancelled && env) setHome(env.homeDir)
          })
        }
      }),
    )
    return () => {
      cancelled = true
      sub.dispose()
    }
  }, [authority, remoteStatus])

  if (authority) return home
  return localHome()
}
