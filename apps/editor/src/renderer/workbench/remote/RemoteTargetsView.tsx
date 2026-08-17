/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteTargetsView — the single "Targets" view of the Remote Explorer
 *  container. Merges the former SSH Targets / WSL Targets / Connections / Recent
 *  views into one tree: two collapsible groups (SSH always, WSL data-driven),
 *  each target row showing its live connection state, and its recent remote
 *  workspaces as indented child rows. Left-click / Enter runs the row's primary
 *  action (connect / open folder / retry per state; recent rows open in the
 *  current window, ctrl/cmd+click in a new one); hover reveals the same
 *  actions as floating buttons; right-click opens the RemoteExplorerContext menu.
 *  This view owns the explorer's mount-triggered refresh (it is the only view,
 *  so data is fetched exactly once per container open).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Plug, RefreshCw, Square, X } from 'lucide-react'
import {
  ICommandService,
  IWorkspaceService,
  isWslAuthority,
  localize,
} from '@universe-editor/platform'
import { IconButton } from '@universe-editor/workbench-ui'
import { useEventValue, useObservable, useService } from '../useService.js'
import { IRemoteExplorerService } from '../../services/remote/RemoteExplorerService.js'
import {
  CloseConnectionAction,
  ConnectToHostAction,
  OpenFolderOnHostAction,
  RemoveManualHostAction,
  RetryConnectionAction,
  StopRemoteServerAction,
} from '../../actions/remoteActions.js'
import {
  OpenWorkspaceInCurrentWindowAction,
  OpenWorkspaceInNewWindowAction,
  RemoveRecentWorkspaceAction,
} from '../../actions/workspaceActions.js'
import { workspaceFullLabel } from '../../services/workspace/workspaceLabel.js'
import {
  buildRemoteTree,
  type RemoteTreeGroup,
  type RemoteTreeRecent,
  type RemoteTreeTarget,
} from './remoteTree.js'
import { RemoteRow } from './RemoteRow.js'
import { RemoteContextMenu, type RemoteMenuState } from './RemoteContextMenu.js'
import { remoteRowPrimaryAction } from './remoteRowActions.js'
import { useRemoteRowMenu } from './useRemoteRowMenu.js'
import styles from './RemoteExplorer.module.css'

const GROUP_LABELS = {
  ssh: localize('remote.group.ssh', 'SSH'),
  wsl: localize('remote.group.wsl', 'WSL'),
} as const

type OpenMenu = (target: RemoteMenuState['target']) => (e: React.MouseEvent<HTMLDivElement>) => void

export function RemoteTargetsView() {
  const explorer = useService(IRemoteExplorerService)
  const workspace = useService(IWorkspaceService)
  const sshTargets = useObservable(explorer.sshTargets)
  const wslDistros = useObservable(explorer.wslDistros)
  const connections = useObservable(explorer.connections)
  const recents = useEventValue(
    workspace.onDidChangeRecent,
    useCallback(() => workspace.recent, [workspace]),
  )
  const { menu, openMenu, closeMenu } = useRemoteRowMenu()

  // The view only mounts while visible, so refreshing on mount is "refresh on open".
  useEffect(() => {
    void explorer.refresh()
  }, [explorer])

  const tree = useMemo(
    () => buildRemoteTree({ sshTargets, wslDistros, connections, recents }),
    [sshTargets, wslDistros, connections, recents],
  )

  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [collapsedTargets, setCollapsedTargets] = useState<ReadonlySet<string>>(() => new Set())

  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleTarget = useCallback((authority: string) => {
    setCollapsedTargets((prev) => {
      const next = new Set(prev)
      if (next.has(authority)) next.delete(authority)
      else next.add(authority)
      return next
    })
  }, [])

  const ssh = tree.groups.find((g) => g.id === 'ssh')!
  const wsl = tree.groups.find((g) => g.id === 'wsl')!

  return (
    <div className={styles['view']} data-testid="remote-targets-view">
      <GroupSection
        group={ssh}
        collapsed={collapsedGroups.has('ssh')}
        onToggle={() => toggleGroup('ssh')}
        collapsedTargets={collapsedTargets}
        onToggleTarget={toggleTarget}
        openMenu={openMenu}
        showEmpty={ssh.targets.length === 0}
      />
      {wsl.targets.length > 0 && (
        <GroupSection
          group={wsl}
          collapsed={collapsedGroups.has('wsl')}
          onToggle={() => toggleGroup('wsl')}
          collapsedTargets={collapsedTargets}
          onToggleTarget={toggleTarget}
          openMenu={openMenu}
        />
      )}
      {menu && <RemoteContextMenu state={menu} onClose={closeMenu} />}
    </div>
  )
}

function GroupSection({
  group,
  collapsed,
  onToggle,
  collapsedTargets,
  onToggleTarget,
  openMenu,
  showEmpty,
}: {
  group: RemoteTreeGroup
  collapsed: boolean
  onToggle: () => void
  collapsedTargets: ReadonlySet<string>
  onToggleTarget: (authority: string) => void
  openMenu: OpenMenu
  showEmpty?: boolean
}) {
  const hasTargets = group.targets.length > 0
  return (
    <>
      <RemoteRow
        testId={`remote-group-row-${group.id}`}
        label={GROUP_LABELS[group.id]}
        tooltip={GROUP_LABELS[group.id]}
        emphasized
        chevron={hasTargets ? { expanded: !collapsed, onToggle } : undefined}
        onActivate={hasTargets ? onToggle : undefined}
      />
      {!collapsed && (
        <>
          {showEmpty && (
            <div className={styles['empty']}>
              {localize('remote.targets.empty', 'No SSH targets. Add one or use an SSH config.')}
            </div>
          )}
          {group.targets.map((target) => (
            <TargetRow
              key={target.authority}
              target={target}
              collapsed={collapsedTargets.has(target.authority)}
              onToggle={() => onToggleTarget(target.authority)}
              openMenu={openMenu}
            />
          ))}
        </>
      )}
    </>
  )
}

function TargetRow({
  target,
  collapsed,
  onToggle,
  openMenu,
}: {
  target: RemoteTreeTarget
  collapsed: boolean
  onToggle: () => void
  openMenu: OpenMenu
}) {
  const commands = useService(ICommandService)
  const connected = target.state === 'connected'
  const failed = target.state === 'failed'
  const reconnecting = target.state === 'reconnecting'
  const primary = remoteRowPrimaryAction(target.state)
  const hasRecents = target.recents.length > 0

  const tooltip = target.isRunning
    ? localize('remote.wsl.runningTooltip', '{name} (running)', { name: target.label })
    : target.label

  const description = target.isDefault ? localize('remote.wsl.default', 'default') : undefined

  return (
    <>
      <RemoteRow
        testId="remote-target-row"
        dot={target.state}
        label={target.label}
        tooltip={tooltip}
        description={description}
        indent={1}
        chevron={hasRecents ? { expanded: !collapsed, onToggle } : undefined}
        onActivate={
          primary === null
            ? undefined
            : () => void commands.executeCommand(primary, target.authority)
        }
        onContextMenu={openMenu({
          kind: target.kind,
          state: target.state,
          manual: target.manual,
          arg: target.authority,
        })}
        actions={
          <>
            {connected && (
              <IconButton
                label={localize('remote.target.openFolder', 'Open Folder on Host...')}
                onClick={() =>
                  void commands.executeCommand(OpenFolderOnHostAction.ID, target.authority)
                }
              >
                <FolderOpen size={14} strokeWidth={1.75} />
              </IconButton>
            )}
            {failed && (
              <IconButton
                label={localize('remote.connection.retry', 'Retry Connection')}
                onClick={() =>
                  void commands.executeCommand(RetryConnectionAction.ID, target.authority)
                }
              >
                <RefreshCw size={14} strokeWidth={1.75} />
              </IconButton>
            )}
            {!connected && !failed && !reconnecting && (
              <IconButton
                label={
                  isWslAuthority(target.authority)
                    ? localize('remote.wsl.connect', 'Connect to WSL...')
                    : localize('remote.target.connect', 'Connect to Host...')
                }
                onClick={() =>
                  void commands.executeCommand(ConnectToHostAction.ID, target.authority)
                }
              >
                <Plug size={14} strokeWidth={1.75} />
              </IconButton>
            )}
            {(connected || reconnecting) && (
              <IconButton
                label={localize('remote.connection.close', 'Close Connection')}
                onClick={() =>
                  void commands.executeCommand(CloseConnectionAction.ID, target.authority)
                }
              >
                <X size={14} strokeWidth={1.75} />
              </IconButton>
            )}
            {connected && (
              <IconButton
                label={localize('remote.connection.stopServer', 'Stop Remote Server')}
                onClick={() =>
                  void commands.executeCommand(StopRemoteServerAction.ID, target.authority)
                }
              >
                <Square size={14} strokeWidth={1.75} />
              </IconButton>
            )}
            {target.manual && (
              <IconButton
                label={localize('remote.target.forget', 'Forget')}
                onClick={() =>
                  void commands.executeCommand(RemoveManualHostAction.ID, target.authority)
                }
              >
                <X size={14} strokeWidth={1.75} />
              </IconButton>
            )}
          </>
        }
      />
      {!collapsed &&
        target.recents.map((recent) => (
          <RecentRow
            key={recent.folder.toString()}
            recent={recent}
            onContextMenu={openMenu({
              kind: 'recent',
              state: undefined,
              manual: false,
              arg: recent.folder.toString(),
            })}
          />
        ))}
    </>
  )
}

function RecentRow({
  recent,
  onContextMenu,
}: {
  recent: RemoteTreeRecent
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
}) {
  const commands = useService(ICommandService)

  return (
    <RemoteRow
      testId="remote-recent-row"
      label={recent.label}
      tooltip={workspaceFullLabel(recent.folder)}
      description={recent.description}
      truncateDescription
      indent={2}
      onActivate={(e) => {
        const id =
          e.ctrlKey || e.metaKey
            ? OpenWorkspaceInNewWindowAction.ID
            : OpenWorkspaceInCurrentWindowAction.ID
        void commands.executeCommand(id, recent.folder.toString())
      }}
      onContextMenu={onContextMenu}
      actions={
        <IconButton
          label={localize('remote.recent.remove', 'Remove from Recent')}
          onClick={() =>
            void commands.executeCommand(RemoveRecentWorkspaceAction.ID, recent.folder.toString())
          }
        >
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      }
    />
  )
}
