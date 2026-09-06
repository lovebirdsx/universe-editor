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
 *
 *  Rendering goes through the shared `Tree`, so the view inherits the same
 *  keyboard model as Explorer / Search / SCM (arrows, Home/End, Page, Enter,
 *  ContextMenu key) instead of maintaining its own. Collapse state lives in the
 *  TreeModel; the row components are pure presentation.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { FolderOpen, Plug, RefreshCw, Square, X } from 'lucide-react'
import {
  ICommandService,
  IWorkspaceService,
  isWslAuthority,
  localize,
} from '@universe-editor/platform'
import {
  IconButton,
  Tree,
  TreeModel,
  useOwnedTreeModel,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import { useEventValue, useObservable, useService } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
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
import { buildRemoteTree, type RemoteTreeTarget } from './remoteTree.js'
import {
  buildRemoteTreeSnapshot,
  createRemoteTreeDataSource,
  type IRemoteTreeSnapshot,
  type RemoteNode,
} from './remoteTreeDataSource.js'
import { RemoteRow, REMOTE_ROW_INDENT_BASE, REMOTE_ROW_INDENT_WIDTH } from './RemoteRow.js'
import { RemoteContextMenu, type RemoteMenuState } from './RemoteContextMenu.js'
import { remoteRowPrimaryAction } from './remoteRowActions.js'
import { useRemoteRowMenu } from './useRemoteRowMenu.js'
import styles from './RemoteExplorer.module.css'

export const REMOTE_TARGETS_VIEW_ID = 'workbench.view.remote.targets'

const GROUP_LABELS = {
  ssh: localize('remote.group.ssh', 'SSH'),
  wsl: localize('remote.group.wsl', 'WSL'),
} as const

/** Row test ids kept stable across the tree migration (e2e + unit selectors). */
const ROW_TEST_IDS = {
  target: 'remote-target-row',
  recent: 'remote-recent-row',
} as const

export function RemoteTargetsView() {
  const explorer = useService(IRemoteExplorerService)
  const workspace = useService(IWorkspaceService)
  const commands = useService(ICommandService)
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

  const emptySshMessage = localize(
    'remote.targets.empty',
    'No SSH targets. Add one or use an SSH config.',
  )

  const snapshot = useMemo(
    () =>
      buildRemoteTreeSnapshot(
        buildRemoteTree({ sshTargets, wslDistros, connections, recents }),
        emptySshMessage,
      ),
    [sshTargets, wslDistros, connections, recents, emptySshMessage],
  )

  // The data source reads the latest snapshot through a ref so the model built
  // once at mount keeps serving fresh data after every refresh.
  const snapshotRef = useRef<IRemoteTreeSnapshot>(snapshot)
  snapshotRef.current = snapshot

  // useOwnedTreeModel, not useMemo: a bare memo + cleanup dispose() is disposed
  // by StrictMode's mount dry-run and the dead instance reused on remount, which
  // silently stops the tree updating (dev-only, never in production builds).
  const model = useOwnedTreeModel(
    () =>
      new TreeModel<RemoteNode>({
        dataSource: createRemoteTreeDataSource(() => snapshotRef.current),
        // Everything starts open — the pre-tree view rendered every level.
        defaultExpanded: () => true,
      }),
  )

  useEffect(() => {
    model.refresh()
  }, [snapshot, model])

  const treeRef = useRef<HTMLDivElement>(null)
  useViewFocusable(
    REMOTE_TARGETS_VIEW_ID,
    useCallback(() => treeRef.current, []),
  )

  // Focus landing without a (still-visible) focused row selects the first, so
  // the arrows have somewhere to start — the same onFocus seeding every other
  // tree view does. The visibility check matters because refresh() does not
  // clear `_focused`: an id from a previous snapshot must not pass for a live
  // cursor when the host it named has since disappeared.
  const onTreeFocus = useCallback(() => {
    const visible = model.getVisibleNodes()
    const focusedId = model.focused
    if (focusedId != null && visible.some((n) => n.id === focusedId)) return
    const first = visible[0]
    if (first) model.setSelection([first.id], first.id)
  }, [model])

  const runPrimaryAction = useCallback(
    (node: RemoteNode, modifiers: { ctrlKey: boolean; metaKey: boolean }) => {
      if (node.kind === 'target') {
        const primary = remoteRowPrimaryAction(node.target.state)
        if (primary !== null) void commands.executeCommand(primary, node.target.authority)
        return
      }
      if (node.kind === 'recent') {
        const id =
          modifiers.ctrlKey || modifiers.metaKey
            ? OpenWorkspaceInNewWindowAction.ID
            : OpenWorkspaceInCurrentWindowAction.ID
        void commands.executeCommand(id, node.recent.folder.toString())
      }
    },
    [commands],
  )

  const menuTargetFor = useCallback((node: RemoteNode): RemoteMenuState['target'] | null => {
    if (node.kind === 'target') {
      return {
        kind: node.target.kind,
        state: node.target.state,
        manual: node.target.manual,
        arg: node.target.authority,
      }
    }
    if (node.kind === 'recent') {
      return {
        kind: 'recent',
        state: undefined,
        manual: false,
        arg: node.recent.folder.toString(),
      }
    }
    return null
  }, [])

  const renderRow = useCallback(
    (ctx: ITreeRowRenderContext<RemoteNode>) => {
      const node = ctx.node.element
      const chevron = ctx.node.hasChildren
        ? { expanded: ctx.node.expanded, onToggle: ctx.onToggle }
        : undefined
      const shared = {
        rowKey: ctx.node.id,
        indentPadding: ctx.indentPadding,
        selected: ctx.isSelected,
        focused: ctx.isFocused,
        style: ctx.style,
        ...(chevron ? { chevron, ariaExpanded: ctx.node.expanded } : {}),
      }
      const menuTarget = menuTargetFor(node)
      const onContextMenu = menuTarget ? openMenu(menuTarget) : undefined

      switch (node.kind) {
        case 'group': {
          const label = GROUP_LABELS[node.group.id]
          return (
            <RemoteRow
              {...shared}
              testId={`remote-group-row-${node.group.id}`}
              label={label}
              tooltip={label}
              emphasized
              onClick={ctx.onClickRow}
            />
          )
        }
        case 'empty':
          return (
            <RemoteRow
              {...shared}
              testId={`remote-group-empty-${node.groupId}`}
              label={node.message}
              tooltip={node.message}
              inert
            />
          )
        case 'target':
          return (
            <RemoteRow
              {...shared}
              testId={ROW_TEST_IDS.target}
              dot={node.target.state}
              label={node.target.label}
              tooltip={targetTooltip(node.target)}
              description={
                node.target.isDefault ? localize('remote.wsl.default', 'default') : undefined
              }
              onClick={ctx.onClickRow}
              onContextMenu={onContextMenu}
              actions={<TargetActions target={node.target} />}
            />
          )
        case 'recent':
          return (
            <RemoteRow
              {...shared}
              testId={ROW_TEST_IDS.recent}
              label={node.recent.label}
              tooltip={workspaceFullLabel(node.recent.folder)}
              description={node.recent.description}
              truncateDescription
              onClick={ctx.onClickRow}
              onContextMenu={onContextMenu}
              actions={
                <IconButton
                  label={localize('remote.recent.remove', 'Remove from Recent')}
                  onClick={() =>
                    void commands.executeCommand(
                      RemoveRecentWorkspaceAction.ID,
                      node.recent.folder.toString(),
                    )
                  }
                >
                  <X size={14} strokeWidth={1.75} />
                </IconButton>
              }
            />
          )
      }
    },
    [commands, menuTargetFor, openMenu],
  )

  return (
    <div className={styles['viewWrapper']} data-testid="remote-targets-view">
      <Tree<RemoteNode>
        model={model}
        rootRef={treeRef}
        className={styles['view'] ?? ''}
        ariaLabel={localize('remote.targets.ariaLabel', 'Remote targets')}
        indentBase={REMOTE_ROW_INDENT_BASE}
        indentWidth={REMOTE_ROW_INDENT_WIDTH}
        renderRow={renderRow}
        onActivate={(node, _opts) => runPrimaryAction(node.element, NO_MODIFIERS)}
        onFocus={onTreeFocus}
        // Every row is an action target; expansion stays on Left/Right and the
        // chevron, so Enter on a target connects instead of merely folding it.
        activateNonLeafOnEnter
      />
      {menu && <RemoteContextMenu state={menu} onClose={closeMenu} />}
    </div>
  )
}

const NO_MODIFIERS = { ctrlKey: false, metaKey: false } as const

function targetTooltip(target: RemoteTreeTarget): string {
  return target.isRunning
    ? localize('remote.wsl.runningTooltip', '{name} (running)', { name: target.label })
    : target.label
}

function TargetActions({ target }: { target: RemoteTreeTarget }) {
  const commands = useService(ICommandService)
  const connected = target.state === 'connected'
  const failed = target.state === 'failed'
  const reconnecting = target.state === 'reconnecting'

  return (
    <>
      {connected && (
        <IconButton
          label={localize('remote.target.openFolder', 'Open Folder on Host...')}
          onClick={() => void commands.executeCommand(OpenFolderOnHostAction.ID, target.authority)}
        >
          <FolderOpen size={14} strokeWidth={1.75} />
        </IconButton>
      )}
      {failed && (
        <IconButton
          label={localize('remote.connection.retry', 'Retry Connection')}
          onClick={() => void commands.executeCommand(RetryConnectionAction.ID, target.authority)}
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
          onClick={() => void commands.executeCommand(ConnectToHostAction.ID, target.authority)}
        >
          <Plug size={14} strokeWidth={1.75} />
        </IconButton>
      )}
      {(connected || reconnecting) && (
        <IconButton
          label={localize('remote.connection.close', 'Close Connection')}
          onClick={() => void commands.executeCommand(CloseConnectionAction.ID, target.authority)}
        >
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      )}
      {connected && (
        <IconButton
          label={localize('remote.connection.stopServer', 'Stop Remote Server')}
          onClick={() => void commands.executeCommand(StopRemoteServerAction.ID, target.authority)}
        >
          <Square size={14} strokeWidth={1.75} />
        </IconButton>
      )}
      {target.manual && (
        <IconButton
          label={localize('remote.target.forget', 'Forget')}
          onClick={() => void commands.executeCommand(RemoveManualHostAction.ID, target.authority)}
        >
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      )}
    </>
  )
}
