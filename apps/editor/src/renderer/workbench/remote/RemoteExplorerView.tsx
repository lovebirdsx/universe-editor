/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteExplorerView — the Remote Explorer sidebar view (VSCode's Remote Explorer,
 *  simplified). Three groups:
 *    - SSH Targets:  ~/.ssh/config hosts + manually-added hosts (connect / open /
 *      forget), with a "+ Add New" input.
 *    - Connections:  live per-authority connections (open / retry / close / stop).
 *    - Recent:       recent remote-ssh workspaces (open / remove).
 *  Pure presentation: all data comes from IRemoteExplorerService + IWorkspaceService,
 *  and every action goes through the existing command / service surface.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo } from 'react'
import { FolderOpen, Plug, Plus, RefreshCw, Square, X } from 'lucide-react'
import {
  ICommandService,
  IQuickInputService,
  IWorkspaceService,
  REMOTE_SCHEME,
  localize,
  type IRecentWorkspace,
} from '@universe-editor/platform'
import { IconButton, cx } from '@universe-editor/workbench-ui'
import { useEventValue, useObservable, useService } from '../useService.js'
import {
  IRemoteExplorerService,
  type RemoteSshTarget,
} from '../../services/remote/RemoteExplorerService.js'
import type { RemoteConnectionStateDto } from '../../../shared/ipc/remoteStatusService.js'
import {
  CloseConnectionAction,
  ConnectToHostAction,
  OpenFolderOnHostAction,
  RetryConnectionAction,
  StopRemoteServerAction,
} from '../../actions/remoteActions.js'
import { workspaceFullLabel } from '../../services/workspace/workspaceLabel.js'
import styles from './RemoteExplorerView.module.css'

function dotClass(state: RemoteConnectionStateDto | undefined): string | undefined {
  switch (state) {
    case 'connected':
      return styles['dotConnected']
    case 'reconnecting':
    case 'deploying':
    case 'forwarding':
    case 'handshaking':
      return styles['dotConnecting']
    case 'failed':
      return styles['dotFailed']
    default:
      return styles['dotIdle']
  }
}

export function RemoteExplorerView() {
  const explorer = useService(IRemoteExplorerService)
  const commands = useService(ICommandService)
  const quickInput = useService(IQuickInputService)
  const workspace = useService(IWorkspaceService)

  const sshTargets = useObservable(explorer.sshTargets)
  const connections = useObservable(explorer.connections)
  const activeConnections = useMemo(
    () => connections.filter((c) => c.state !== 'idle' && c.state !== 'disposed'),
    [connections],
  )
  const recent = useEventValue(
    workspace.onDidChangeRecent,
    useCallback(
      () => workspace.recent.filter((r) => r.folder.scheme === REMOTE_SCHEME),
      [workspace],
    ),
  )

  // The view only mounts while visible, so refreshing on mount is "refresh on open".
  useEffect(() => {
    void explorer.refresh()
  }, [explorer])

  const connectionState = useCallback(
    (authority: string): RemoteConnectionStateDto | undefined =>
      connections.find((c) => c.authority === authority)?.state,
    [connections],
  )

  const addNewHost = useCallback(async () => {
    const host = await quickInput.input({
      prompt: localize('remote.addHost.prompt', 'SSH host'),
      placeholder: localize('remote.addHost.placeholder', 'user@host[:port]'),
    })
    if (host === undefined || host.trim() === '') return
    await explorer.addManualHost(host)
  }, [explorer, quickInput])

  const run = useCallback(
    (commandId: string, authority: string) => void commands.executeCommand(commandId, authority),
    [commands],
  )

  return (
    <div className={styles['container']} data-testid="remote-explorer-view">
      <div className={styles['scroll']}>
        <section className={styles['section']}>
          <div className={styles['sectionHeader']}>
            <span className={styles['sectionTitle']}>
              {localize('remote.section.targets', 'SSH Targets')}
            </span>
            <IconButton
              label={localize('remote.addHost.title', 'Add New SSH Host')}
              onClick={() => void addNewHost()}
            >
              <Plus size={14} strokeWidth={1.75} />
            </IconButton>
          </div>
          {sshTargets.length === 0 && (
            <div className={styles['message']}>
              {localize('remote.targets.empty', 'No SSH targets. Add one or use an SSH config.')}
            </div>
          )}
          {sshTargets.map((target) => (
            <TargetRow
              key={target.host}
              target={target}
              state={connectionState(target.host)}
              onConnect={() => run(ConnectToHostAction.ID, target.host)}
              onOpenFolder={() => run(OpenFolderOnHostAction.ID, target.host)}
              onForget={() => void explorer.removeManualHost(target.host)}
            />
          ))}
        </section>

        <section className={styles['section']}>
          <div className={styles['sectionHeader']}>
            <span className={styles['sectionTitle']}>
              {localize('remote.section.connections', 'Connections')}
            </span>
            <span className={styles['count']}>{activeConnections.length}</span>
          </div>
          {activeConnections.length === 0 && (
            <div className={styles['message']}>{localize('remote.connections.empty', 'None')}</div>
          )}
          {activeConnections.map((c) => (
            <ConnectionRow
              key={c.authority}
              authority={c.authority}
              state={c.state}
              onOpenFolder={() => run(OpenFolderOnHostAction.ID, c.authority)}
              onRetry={() => run(RetryConnectionAction.ID, c.authority)}
              onClose={() => run(CloseConnectionAction.ID, c.authority)}
              onStopServer={() => run(StopRemoteServerAction.ID, c.authority)}
            />
          ))}
        </section>

        <section className={styles['section']}>
          <div className={styles['sectionHeader']}>
            <span className={styles['sectionTitle']}>
              {localize('remote.section.recent', 'Recent')}
            </span>
            <span className={styles['count']}>{recent.length}</span>
          </div>
          {recent.length === 0 && (
            <div className={styles['message']}>{localize('remote.recent.empty', 'None')}</div>
          )}
          {recent.map((entry) => (
            <RecentRow
              key={entry.folder.toString()}
              entry={entry}
              onOpen={() => void workspace.openFolder(entry.folder)}
              onRemove={() => void workspace.removeRecent(entry.folder)}
            />
          ))}
        </section>
      </div>
    </div>
  )
}

function TargetRow({
  target,
  state,
  onConnect,
  onOpenFolder,
  onForget,
}: {
  target: RemoteSshTarget
  state: RemoteConnectionStateDto | undefined
  onConnect: () => void
  onOpenFolder: () => void
  onForget: () => void
}) {
  const connected = state === 'connected'
  return (
    <div className={styles['row']} data-testid="remote-target-row">
      <span className={cx(styles['dot'], dotClass(state))} aria-hidden="true" />
      <span className={styles['label']} data-tooltip={target.host}>
        {target.host}
      </span>
      <span className={styles['actions']}>
        {connected ? (
          <IconButton
            label={localize('remote.target.openFolder', 'Open Folder on Host...')}
            onClick={onOpenFolder}
          >
            <FolderOpen size={14} strokeWidth={1.75} />
          </IconButton>
        ) : (
          <IconButton
            label={localize('remote.target.connect', 'Connect to Host...')}
            onClick={onConnect}
          >
            <Plug size={14} strokeWidth={1.75} />
          </IconButton>
        )}
        {target.manual && (
          <IconButton label={localize('remote.target.forget', 'Forget')} onClick={onForget}>
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        )}
      </span>
    </div>
  )
}

function ConnectionRow({
  authority,
  state,
  onOpenFolder,
  onRetry,
  onClose,
  onStopServer,
}: {
  authority: string
  state: RemoteConnectionStateDto
  onOpenFolder: () => void
  onRetry: () => void
  onClose: () => void
  onStopServer: () => void
}) {
  return (
    <div className={styles['row']} data-testid="remote-connection-row">
      <span className={cx(styles['dot'], dotClass(state))} aria-hidden="true" />
      <span className={styles['label']} data-tooltip={authority}>
        {authority}
      </span>
      <span className={styles['actions']}>
        {state === 'connected' && (
          <IconButton
            label={localize('remote.connection.openFolder', 'Open Folder on Host...')}
            onClick={onOpenFolder}
          >
            <FolderOpen size={14} strokeWidth={1.75} />
          </IconButton>
        )}
        {state === 'failed' && (
          <IconButton
            label={localize('remote.connection.retry', 'Retry Connection')}
            onClick={onRetry}
          >
            <RefreshCw size={14} strokeWidth={1.75} />
          </IconButton>
        )}
        {(state === 'connected' || state === 'reconnecting') && (
          <IconButton
            label={localize('remote.connection.close', 'Close Connection')}
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        )}
        {state === 'connected' && (
          <IconButton
            label={localize('remote.connection.stopServer', 'Stop Remote Server')}
            onClick={onStopServer}
          >
            <Square size={14} strokeWidth={1.75} />
          </IconButton>
        )}
      </span>
    </div>
  )
}

function RecentRow({
  entry,
  onOpen,
  onRemove,
}: {
  entry: IRecentWorkspace
  onOpen: () => void
  onRemove: () => void
}) {
  return (
    <div className={styles['row']} data-testid="remote-recent-row" onClick={onOpen}>
      <span className={styles['label']} data-tooltip={workspaceFullLabel(entry.folder)}>
        {entry.name}
      </span>
      <span className={styles['actions']}>
        <IconButton
          label={localize('remote.recent.remove', 'Remove from Recent')}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      </span>
    </div>
  )
}
