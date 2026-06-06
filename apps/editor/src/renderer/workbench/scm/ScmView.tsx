/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmView — the built-in Source Control viewlet. It renders whatever
 *  SourceControl providers extensions register through the `scm` API (mirrored
 *  into IScmService): a commit box, the provider's title toolbar (icon actions +
 *  a `…` overflow menu), and its resource groups shown either as a flat list or
 *  a nested folder tree, with per-row inline actions revealed on hover.
 *
 *  The view owns no git knowledge — providers supply resource states, commands
 *  and decorations; menu contributions (scm/title, scm/resourceState/context)
 *  supply the actions and their icons. Clicking an action runs its command
 *  through the normal command flow (→ extension host). View mode (list/tree) is
 *  the view's own concern, persisted through IStorageService.
 *--------------------------------------------------------------------------------------------*/

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  CommandsRegistry,
  ContextKeyExpr,
  ICommandService,
  IEditorResolverService,
  IStorageService,
  autorun,
  isSubmenuEntry,
  MenuId,
  MenuRegistry,
  StorageScope,
  URI,
  localize,
  type IContext,
  type ContextKeyExpression,
} from '@universe-editor/platform'
import type {
  ICommandDto,
  ISourceControlResourceStateDto,
} from '@universe-editor/extensions-common'
import {
  Tree,
  TreeModel,
  useOwnedTreeModel,
  type ITreeDataSource,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import { FileIcon } from '../files/fileIconTheme.js'
import { useService, useObservable } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
import {
  IScmService,
  type IScmGroupModel,
  type IScmSourceControlModel,
} from '../../services/extensions/ScmService.js'
import styles from './ScmView.module.css'

interface ActionItem {
  readonly id: string
  readonly title: string
  readonly command: string
  readonly icon?: string | undefined
  readonly group?: string | undefined
}

type ViewMode = 'list' | 'tree'

const VIEW_MODE_STORAGE_KEY = 'scm.viewMode'

function evalWhen(
  when: string | ContextKeyExpression | undefined,
  scope: Record<string, unknown>,
): boolean {
  if (!when) return true
  const expr = typeof when === 'string' ? ContextKeyExpr.deserialize(when) : when
  if (!expr) return true
  return expr.evaluate({ getValue: (key: string) => scope[key] } as IContext)
}

/** Re-render trigger that fires whenever any menu contribution changes. */
function useMenuRevision(): number {
  const [rev, setRev] = useState(0)
  useLayoutEffect(() => {
    const d = MenuRegistry.onDidChangeMenu(() => setRev((v) => v + 1))
    return () => d.dispose()
  }, [])
  return rev
}

/** Menu items for a location filtered by `when`, resolved to ActionItems. */
function menuActions(menuId: MenuId, scope: Record<string, unknown>, group?: string): ActionItem[] {
  const out: ActionItem[] = []
  for (const entry of MenuRegistry.getMenuItems(menuId)) {
    if (isSubmenuEntry(entry)) continue
    if (group !== undefined && entry.group !== group) continue
    if (!evalWhen(entry.when, scope)) continue
    const cmd = CommandsRegistry.getCommand(entry.command)
    out.push({
      id: entry.command,
      title: entry.title ?? cmd?.metadata?.description ?? entry.command,
      command: entry.command,
      icon: entry.icon,
      group: entry.group,
    })
  }
  return out
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i === -1 ? path : path.slice(i + 1)
}

/** Path relative to the provider root, with forward slashes. */
function relativePath(root: string | undefined, abs: string): string {
  const a = abs.replace(/\\/g, '/')
  if (!root) return a
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : a
}

function dirname(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i === -1 ? '' : rel.slice(0, i)
}

/** Join a provider root with a forward-slashed relative folder path. */
function joinFolder(root: string | undefined, rel: string): string {
  if (!root) return rel
  return `${root.replace(/[\\/]+$/, '')}/${rel}`
}

function decorationStyle(resource: ISourceControlResourceStateDto): CSSProperties {
  const d = resource.decorations
  if (!d) return {}
  return {
    ...(d.color !== undefined ? { color: d.color } : {}),
    ...(d.strikeThrough ? { textDecoration: 'line-through' } : {}),
    ...(d.faded ? { opacity: 0.6 } : {}),
  }
}

/** Icon button that falls back to its title text when no icon is mapped. */
function ActionButton({
  action,
  onRun,
}: {
  action: ActionItem
  onRun: (e: ReactMouseEvent) => void
}) {
  const Icon = resolveHeaderIcon(action.icon)
  return (
    <button type="button" className={styles['actionButton']} title={action.title} onClick={onRun}>
      {Icon ? <Icon size={16} strokeWidth={1.6} /> : <span>{action.title}</span>}
    </button>
  )
}

// --- Tree model ------------------------------------------------------------

interface FolderNode {
  name: string
  path: string
  folders: Map<string, FolderNode>
  files: ISourceControlResourceStateDto[]
}

type ScmNode =
  | { kind: 'group'; id: string; groupId: string; handle: number; label: string; count: number }
  | { kind: 'folder'; id: string; groupId: string; path: string; name: string }
  | {
      kind: 'file'
      id: string
      groupId: string
      resource: ISourceControlResourceStateDto
      dir?: string
    }

interface ScmSnapshot {
  roots: ScmNode[]
  childrenMap: Map<string, ScmNode[]>
  parentMap: Map<string, ScmNode>
  /** Groups + folders — seeded expanded the first time they appear. */
  collapsibleIds: string[]
}

function buildFolderTree(
  resources: readonly ISourceControlResourceStateDto[],
  root: string | undefined,
): FolderNode {
  const rootNode: FolderNode = { name: '', path: '', folders: new Map(), files: [] }
  for (const res of resources) {
    const rel = relativePath(root, res.resourceUri)
    const parts = rel.split('/')
    parts.pop() // drop file name
    let node = rootNode
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      let child = node.folders.get(part)
      if (!child) {
        child = { name: part, path: acc, folders: new Map(), files: [] }
        node.folders.set(part, child)
      }
      node = child
    }
    node.files.push(res)
  }
  return rootNode
}

/** Materialise the provider's groups into a flat-navigable tree snapshot. */
function buildSnapshot(
  groups: readonly IScmGroupModel[],
  rootUri: string | undefined,
  viewMode: ViewMode,
): ScmSnapshot {
  const roots: ScmNode[] = []
  const childrenMap = new Map<string, ScmNode[]>()
  const parentMap = new Map<string, ScmNode>()
  const collapsibleIds: string[] = []

  for (const g of groups) {
    const resources = g.resources.get()
    if (resources.length === 0 && g.hideWhenEmpty.get()) continue
    const groupNodeId = `group:${g.id}`
    const groupNode: ScmNode = {
      kind: 'group',
      id: groupNodeId,
      groupId: g.id,
      handle: g.handle,
      label: g.label.get(),
      count: resources.length,
    }
    roots.push(groupNode)
    collapsibleIds.push(groupNodeId)
    const groupChildren: ScmNode[] = []
    childrenMap.set(groupNodeId, groupChildren)

    if (viewMode === 'tree') {
      const tree = buildFolderTree(resources, rootUri)
      const addLevel = (node: FolderNode, parent: ScmNode, into: ScmNode[]): void => {
        const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
        for (const f of folders) {
          const id = `folder:${g.id}/${f.path}`
          const folderNode: ScmNode = {
            kind: 'folder',
            id,
            groupId: g.id,
            path: f.path,
            name: f.name,
          }
          into.push(folderNode)
          parentMap.set(id, parent)
          collapsibleIds.push(id)
          const children: ScmNode[] = []
          childrenMap.set(id, children)
          addLevel(f, folderNode, children)
        }
        for (const file of node.files) {
          const id = `file:${g.id}/${file.resourceUri}`
          const fileNode: ScmNode = { kind: 'file', id, groupId: g.id, resource: file }
          into.push(fileNode)
          parentMap.set(id, parent)
        }
      }
      addLevel(tree, groupNode, groupChildren)
    } else {
      for (const r of resources) {
        const id = `file:${g.id}/${r.resourceUri}`
        const fileNode: ScmNode = {
          kind: 'file',
          id,
          groupId: g.id,
          resource: r,
          dir: dirname(relativePath(rootUri, r.resourceUri)),
        }
        groupChildren.push(fileNode)
        parentMap.set(id, groupNode)
      }
    }
  }
  return { roots, childrenMap, parentMap, collapsibleIds }
}

/** Shared click semantics: shift=range, ctrl/meta=toggle, plain=select (+onPlain). */
function rowClick(
  model: TreeModel<ScmNode>,
  node: ScmNode,
  e: ReactMouseEvent,
  onPlain: () => void,
): void {
  if (e.shiftKey) {
    e.preventDefault()
    model.selectRange(model.focused ?? node.id, node.id)
    return
  }
  if (e.ctrlKey || e.metaKey) {
    model.toggleInSelection(node.id)
    return
  }
  model.setSelection([node.id], node.id)
  onPlain()
}

function rowClassName(base: string, isSelected: boolean, isFocused: boolean): string {
  return [base, isSelected && styles['selected'], isFocused && styles['focused']]
    .filter(Boolean)
    .join(' ')
}

// --- Rows ------------------------------------------------------------------

interface SharedRowProps {
  model: TreeModel<ScmNode>
  indentPadding: number
  isSelected: boolean
  isFocused: boolean
  expanded: boolean
  hasChildren: boolean
}

const ScmFileRow = memo(function ScmFileRow({
  model,
  node,
  providerId,
  indentPadding,
  isSelected,
  isFocused,
  revision,
}: SharedRowProps & {
  node: Extract<ScmNode, { kind: 'file' }>
  providerId: string
  revision: number
}) {
  const commandService = useService(ICommandService)
  const editorResolverService = useService(IEditorResolverService)
  const resource = node.resource
  const rowScope = useMemo(
    () => ({
      scmProvider: providerId,
      scmResourceGroup: node.groupId,
      scmResourceState: resource.contextValue,
    }),
    [providerId, node.groupId, resource.contextValue],
  )
  const inline = useMemo(
    () => menuActions(MenuId.ScmResourceStateContext, rowScope, 'inline'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowScope, revision],
  )

  const run = (command: string): void => {
    void commandService.executeCommand(command, resource)
  }
  const openChange = (): void => {
    if (resource.command) void commandService.executeCommand(resource.command.command, resource)
  }
  const openChangePinned = (): void => {
    if (resource.command)
      void commandService.executeCommand(resource.command.command, resource, { pinned: true })
  }

  const uri = useMemo(() => URI.file(resource.resourceUri), [resource.resourceUri])
  const openFile = (): void => {
    void editorResolverService.openEditor(uri, { pinned: true })
  }
  const openFileAction: ActionItem = {
    id: 'scm.openFile',
    title: localize('scm.openFile', 'Open File'),
    command: '',
    icon: 'go-to-file',
  }

  return (
    <li
      data-row-key={node.id}
      role="treeitem"
      aria-selected={isSelected}
      className={rowClassName(styles['resource'] ?? '', isSelected, isFocused)}
      style={{ paddingLeft: indentPadding }}
      title={resource.decorations?.tooltip ?? resource.resourceUri}
      onClick={(e) => rowClick(model, node, e, openChange)}
      onDoubleClick={openChangePinned}
    >
      <FileIcon resource={uri} className={styles['fileIcon']} isDirectory={false} size={16} />
      <span className={styles['resourceLabel']} style={decorationStyle(resource)}>
        {basename(resource.resourceUri)}
      </span>
      {node.dir ? <span className={styles['resourceDir']}>{node.dir}</span> : null}
      <span className={styles['resourceActions']}>
        <ActionButton
          action={openFileAction}
          onRun={(e) => {
            e.stopPropagation()
            openFile()
          }}
        />
        {inline.map((a) => (
          <ActionButton
            key={a.id}
            action={a}
            onRun={(e) => {
              e.stopPropagation()
              run(a.command)
            }}
          />
        ))}
      </span>
      {resource.contextValue !== undefined && (
        <span className={styles['statusLetter']} style={decorationStyle(resource)}>
          {resource.contextValue}
        </span>
      )}
    </li>
  )
})

const ScmFolderRow = memo(function ScmFolderRow({
  model,
  node,
  rootUri,
  indentPadding,
  isSelected,
  isFocused,
  expanded,
}: SharedRowProps & {
  node: Extract<ScmNode, { kind: 'folder' }>
  rootUri: string | undefined
  revision: number
}) {
  const commandService = useService(ICommandService)
  const folderUri = useMemo(() => URI.file(node.name), [node.name])
  const absPath = useMemo(() => joinFolder(rootUri, node.path), [rootUri, node.path])

  const run = (command: string, isDirectory = false): void => {
    void commandService.executeCommand(command, { resourceUri: absPath, isDirectory })
  }

  const actions: { action: ActionItem; isDir?: boolean }[] =
    node.groupId === 'index'
      ? [
          {
            action: {
              id: 'git.unstage',
              title: 'Unstage Changes',
              command: 'git.unstage',
              icon: 'remove',
            },
          },
        ]
      : [
          {
            action: {
              id: 'git.discard',
              title: 'Discard Changes',
              command: 'git.discard',
              icon: 'discard',
            },
            isDir: true,
          },
          {
            action: { id: 'git.stage', title: 'Stage Changes', command: 'git.stage', icon: 'add' },
          },
        ]

  return (
    <li
      data-row-key={node.id}
      role="treeitem"
      aria-expanded={expanded}
      aria-selected={isSelected}
      className={rowClassName(styles['folder'] ?? '', isSelected, isFocused)}
      style={{ paddingLeft: indentPadding }}
      onClick={(e) => rowClick(model, node, e, () => void model.toggle(node))}
    >
      <span className={styles['twistie']}>{expanded ? '▾' : '▸'}</span>
      <FileIcon
        resource={folderUri}
        className={styles['fileIcon']}
        isDirectory
        expanded={expanded}
        size={16}
      />
      <span className={styles['folderLabel']}>{node.name}</span>
      <span className={styles['resourceActions']}>
        {actions.map(({ action, isDir }) => (
          <ActionButton
            key={action.id}
            action={action}
            onRun={(e) => {
              e.stopPropagation()
              run(action.command, isDir)
            }}
          />
        ))}
      </span>
    </li>
  )
})

const ScmGroupRow = memo(function ScmGroupRow({
  model,
  node,
  providerId,
  indentPadding,
  isSelected,
  isFocused,
  expanded,
  hasChildren,
  revision,
}: SharedRowProps & {
  node: Extract<ScmNode, { kind: 'group' }>
  providerId: string
  revision: number
}) {
  const commandService = useService(ICommandService)
  const groupScope = useMemo(
    () => ({ scmProvider: providerId, scmResourceGroup: node.groupId }),
    [providerId, node.groupId],
  )
  const groupActions = useMemo(
    () => menuActions(MenuId.ScmResourceGroupContext, groupScope, 'inline'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groupScope, revision],
  )

  return (
    <div
      data-row-key={node.id}
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={isSelected}
      className={rowClassName(styles['groupHeader'] ?? '', isSelected, isFocused)}
      style={{ paddingLeft: indentPadding }}
      onClick={(e) => rowClick(model, node, e, () => void model.toggle(node))}
    >
      <span className={styles['twistie']}>{hasChildren ? (expanded ? '▾' : '▸') : ''}</span>
      <span className={styles['groupLabel']}>{node.label}</span>
      <span className={styles['groupActions']}>
        {groupActions.map((a) => (
          <ActionButton
            key={a.id}
            action={a}
            onRun={(e) => {
              e.stopPropagation()
              void commandService.executeCommand(a.command, { sourceControlId: providerId })
            }}
          />
        ))}
      </span>
      <span className={styles['groupCount']}>{node.count}</span>
    </div>
  )
})

// --- Title overflow menu ---------------------------------------------------

interface OverflowRow {
  kind: 'item' | 'separator'
  id: string
  label?: string
  icon?: string | undefined
  run?: () => void
}

function TitleOverflowMenu({
  anchor,
  rows,
  onClose,
}: {
  anchor: { x: number; y: number }
  rows: OverflowRow[]
  onClose: () => void
}) {
  const ref = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <ul
      ref={ref}
      role="menu"
      className={styles['overflowMenu']}
      style={{ top: anchor.y, left: anchor.x }}
    >
      {rows.map((row) =>
        row.kind === 'separator' ? (
          <li key={row.id} role="separator" className={styles['overflowSeparator']} />
        ) : (
          <li
            key={row.id}
            role="menuitem"
            className={styles['overflowItem']}
            tabIndex={-1}
            onClick={() => {
              onClose()
              row.run?.()
            }}
          >
            {(() => {
              const Icon = resolveHeaderIcon(row.icon)
              return Icon ? (
                <Icon size={16} strokeWidth={1.6} />
              ) : (
                <span className={styles['overflowIconGap']} />
              )
            })()}
            <span>{row.label}</span>
          </li>
        ),
      )}
    </ul>,
    document.body,
  )
}

// --- Provider --------------------------------------------------------------

function ScmProviderView({
  model,
  index,
  viewMode,
  setViewMode,
  revision,
}: {
  model: IScmSourceControlModel
  index: number
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void
  revision: number
}) {
  const scm = useService(IScmService)
  const commandService = useService(ICommandService)
  const storage = useService(IStorageService)
  const inputValue = useObservable(model.inputValue)
  const placeholder = useObservable(model.inputPlaceholder)
  const acceptCommand = useObservable(model.acceptCommand)
  const groups = useObservable(model.groups)

  const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null)
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number } | null>(null)

  // Single TreeModel per provider; its data source reads a snapshot that is
  // rebuilt (during render) whenever groups / resources / view-mode change.
  const snapshotRef = useRef<ScmSnapshot>({
    roots: [],
    childrenMap: new Map(),
    parentMap: new Map(),
    collapsibleIds: [],
  })
  const treeModel = useOwnedTreeModel<ScmNode>(() => {
    const dataSource: ITreeDataSource<ScmNode> = {
      getId: (n) => n.id,
      hasChildren: (n) => (snapshotRef.current.childrenMap.get(n.id)?.length ?? 0) > 0,
      getChildren: (n) => snapshotRef.current.childrenMap.get(n.id) ?? [],
      getRoots: () => snapshotRef.current.roots,
      getParent: (n) => snapshotRef.current.parentMap.get(n.id) ?? null,
    }
    // Groups and folders default to expanded so the first render shows content
    // without depending on a post-mount event reaching the <Tree> subscription.
    return new TreeModel<ScmNode>({ dataSource, defaultExpanded: (n) => n.kind !== 'file' })
  })

  // Bump when any group's resources / label / visibility change.
  const [dataRevision, setDataRevision] = useState(0)
  useEffect(() => {
    const d = autorun((r) => {
      for (const g of groups) {
        g.resources.read(r)
        g.label.read(r)
        g.hideWhenEmpty.read(r)
      }
      setDataRevision((v) => v + 1)
    })
    return () => d.dispose()
  }, [groups])

  // Build the snapshot during render so the tree has content on first paint;
  // invalidate the model's visible cache after the snapshot reference changes.
  const snapshot = useMemo(
    () => buildSnapshot(groups, model.rootUri, viewMode),
    // dataRevision is the recompute signal when resources mutate inside groups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, dataRevision, viewMode, model.rootUri],
  )
  snapshotRef.current = snapshot
  useLayoutEffect(() => {
    treeModel.refresh()
  }, [snapshot, treeModel])

  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Only the first provider claims the view's focus target so multiple repos
  // don't fight over the same focusable id.
  useViewFocusable(
    index === 0 ? 'workbench.view.scm.main' : `scm.provider.${model.handle}`,
    useCallback(() => inputRef.current, []),
  )

  // Persist the commit message per repository so it survives a window reload.
  const inputStorageKey = `scm/input/${model.rootUri ?? model.id}`
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    void storage.get<string>(inputStorageKey, StorageScope.WORKSPACE).then((stored) => {
      if (stored && !model.inputValue.get()) scm.changeInputBoxValue(model.handle, stored)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const id = setTimeout(() => {
      void storage.set(inputStorageKey, inputValue, StorageScope.WORKSPACE)
    }, 300)
    return () => clearTimeout(id)
  }, [inputValue, inputStorageKey, storage])

  // Auto-grow the commit box up to 5 lines, then scroll.
  useLayoutEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const style = getComputedStyle(ta)
    const line = parseFloat(style.lineHeight) || 18
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const max = line * 5 + padding
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden'
  }, [inputValue])

  const scope = useMemo(() => ({ scmProvider: model.id }), [model.id])
  const navActions = useMemo(
    () => menuActions(MenuId.ScmTitle, scope, 'navigation'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, revision],
  )
  const overflowActions = useMemo(
    () => menuActions(MenuId.ScmTitle, scope).filter((a) => a.group !== 'navigation'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, revision],
  )

  const runCommand = (command: ICommandDto | string): void => {
    const id = typeof command === 'string' ? command : command.command
    void commandService.executeCommand(id, { sourceControlId: model.id })
  }

  const collapseAll = (): void => {
    const folderIds = snapshotRef.current.collapsibleIds.filter((id) => id.startsWith('folder:'))
    treeModel.setExpansion(folderIds.map((id) => [id, false] as const))
  }

  const renderRow = (ctx: ITreeRowRenderContext<ScmNode>) => {
    const n = ctx.node.element
    const shared = {
      model: treeModel,
      indentPadding: ctx.indentPadding,
      isSelected: ctx.isSelected,
      isFocused: ctx.isFocused,
      expanded: ctx.node.expanded,
      hasChildren: ctx.node.hasChildren,
    }
    if (n.kind === 'group')
      return (
        <ScmGroupRow key={n.id} {...shared} node={n} providerId={model.id} revision={revision} />
      )
    if (n.kind === 'folder')
      return (
        <ScmFolderRow key={n.id} {...shared} node={n} rootUri={model.rootUri} revision={revision} />
      )
    return <ScmFileRow key={n.id} {...shared} node={n} providerId={model.id} revision={revision} />
  }

  const openOverflow = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setOverflow({ x: rect.right - 220, y: rect.bottom + 2 })
  }

  const openCommitMenu = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setCommitMenu({ x: rect.right - 200, y: rect.bottom + 2 })
  }

  const commitRows = useMemo<OverflowRow[]>(
    () => [
      {
        kind: 'item',
        id: 'git.commit',
        label: 'Commit',
        icon: 'git-commit',
        run: () => runCommand('git.commit'),
      },
      {
        kind: 'item',
        id: 'git.commitAndPush',
        label: 'Commit & Push',
        icon: 'push',
        run: () => runCommand('git.commitAndPush'),
      },
      {
        kind: 'item',
        id: 'git.commitAndSync',
        label: 'Commit & Sync',
        icon: 'sync',
        run: () => runCommand('git.commitAndSync'),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const overflowRows = useMemo<OverflowRow[]>(() => {
    const rows: OverflowRow[] = []
    rows.push(
      viewMode === 'tree'
        ? {
            kind: 'item',
            id: 'view.list',
            label: 'View as List',
            icon: 'list-view',
            run: () => setViewMode('list'),
          }
        : {
            kind: 'item',
            id: 'view.tree',
            label: 'View as Tree',
            icon: 'tree-view',
            run: () => setViewMode('tree'),
          },
    )
    rows.push({
      kind: 'item',
      id: 'view.collapseAll',
      label: 'Collapse All',
      icon: 'collapse-all',
      run: collapseAll,
    })
    let prevGroup: string | undefined
    for (const a of overflowActions) {
      if (prevGroup !== undefined && prevGroup !== a.group) {
        rows.push({ kind: 'separator', id: `sep-${prevGroup}-${a.group}` })
      } else if (prevGroup === undefined) {
        rows.push({ kind: 'separator', id: 'sep-view-git' })
      }
      prevGroup = a.group
      rows.push({
        kind: 'item',
        id: a.id,
        label: a.title,
        icon: a.icon,
        run: () => runCommand(a.command),
      })
    }
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overflowActions, viewMode, groups])

  return (
    <section className={styles['provider']}>
      <div className={styles['providerHeader']}>
        <span className={styles['providerActions']}>
          {navActions.map((a) => (
            <ActionButton key={a.id} action={a} onRun={() => runCommand(a.command)} />
          ))}
          <button
            type="button"
            className={styles['actionButton']}
            title={localize('scm.moreActions', 'More Actions...')}
            onClick={openOverflow}
          >
            {(() => {
              const Icon = resolveHeaderIcon('more')
              return Icon ? <Icon size={16} strokeWidth={1.6} /> : <span>…</span>
            })()}
          </button>
        </span>
      </div>

      <textarea
        ref={inputRef}
        className={styles['commitInput']}
        value={inputValue}
        placeholder={placeholder}
        rows={1}
        onChange={(e) => scm.changeInputBoxValue(model.handle, e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && acceptCommand) {
            e.preventDefault()
            runCommand(acceptCommand)
          }
        }}
      />
      {acceptCommand && (
        <div className={styles['commitBar']}>
          <button
            type="button"
            className={styles['commitButton']}
            onClick={() => runCommand(acceptCommand)}
          >
            {acceptCommand.title}
          </button>
          <button
            type="button"
            className={styles['commitDropdown']}
            title={localize('scm.commitActions', 'Commit actions...')}
            onClick={openCommitMenu}
          >
            ▾
          </button>
        </div>
      )}

      <Tree<ScmNode>
        model={treeModel}
        className={styles['tree'] ?? ''}
        virtualizationThreshold={Number.MAX_SAFE_INTEGER}
        renderRow={renderRow}
        onActivate={(node, opts) => {
          const n = node.element
          if (n.kind !== 'file' || !n.resource.command) return
          if (opts.preview) {
            void commandService.executeCommand(n.resource.command.command, n.resource)
          } else {
            void commandService.executeCommand(n.resource.command.command, n.resource, {
              pinned: true,
            })
          }
        }}
      />

      {overflow && (
        <TitleOverflowMenu
          anchor={overflow}
          rows={overflowRows}
          onClose={() => setOverflow(null)}
        />
      )}
      {commitMenu && (
        <TitleOverflowMenu
          anchor={commitMenu}
          rows={commitRows}
          onClose={() => setCommitMenu(null)}
        />
      )}
    </section>
  )
}

export function ScmView() {
  const scm = useService(IScmService)
  const storage = useService(IStorageService)
  const sourceControls = useObservable(scm.sourceControls)
  const revision = useMenuRevision()
  const [viewMode, setViewModeState] = useState<ViewMode>('list')

  useEffect(() => {
    let active = true
    void storage.get<ViewMode>(VIEW_MODE_STORAGE_KEY, StorageScope.GLOBAL).then((stored) => {
      if (active && (stored === 'list' || stored === 'tree')) setViewModeState(stored)
    })
    return () => {
      active = false
    }
  }, [storage])

  const setViewMode = (mode: ViewMode): void => {
    setViewModeState(mode)
    void storage.set(VIEW_MODE_STORAGE_KEY, mode, StorageScope.GLOBAL)
  }

  return (
    <div className={styles['scmView']} tabIndex={-1}>
      {sourceControls.length === 0 ? (
        <div className={styles['empty']}>
          {localize('scm.empty', 'No source control providers registered.')}
        </div>
      ) : (
        sourceControls.map((sc, i) => (
          <ScmProviderView
            key={sc.handle}
            model={sc}
            index={i}
            viewMode={viewMode}
            setViewMode={setViewMode}
            revision={revision}
          />
        ))
      )}
    </div>
  )
}
