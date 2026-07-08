/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmView — the built-in Source Control viewlet. It renders whatever
 *  SourceControl providers extensions register through the `scm` API (mirrored
 *  into IScmService): a commit box, the provider's title toolbar (icon actions +
 *  a `…` overflow menu), and its resource groups shown either as a flat list or
 *  a nested folder tree, with per-row inline actions revealed on hover.
 *
 *  The view is provider-driven: providers supply resource states, commands and
 *  decorations; menu contributions (scm/title, scm/resourceState/context)
 *  supply the actions and their icons. Git keeps a narrow built-in affordance
 *  for commit-button defaults. Clicking an action runs its command through the
 *  normal command flow (-> extension host). View mode (list/tree) is the view's
 *  own concern, persisted through IStorageService.
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
import {
  ICommandService,
  IEditorGroupsService,
  IEditorResolverService,
  IStorageService,
  autorun,
  MenuId,
  StorageScope,
  URI,
  localize,
} from '@universe-editor/platform'
import type {
  ICommandDto,
  ISourceControlResourceStateDto,
} from '@universe-editor/extensions-common'
import {
  Tree,
  TreeModel,
  useOwnedTreeModel,
  resourceDragProps,
  selectionDragUris,
  type ITreeDataSource,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { FileIcon } from '../files/fileIconTheme.js'
import { isMarkdownPreviewResource } from '../files/resourceLanguage.js'
import { useService, useObservable } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import { openMarkdownPreviewInGroup } from '../../services/editor/openMarkdownPreview.js'
import {
  IScmService,
  type IScmGroupModel,
  type IScmSourceControlModel,
} from '../../services/extensions/ScmService.js'
import {
  ActionButton,
  TitleOverflowMenu,
  menuActions,
  useMenuRevision,
  type ActionItem,
  type OverflowRow,
  type ViewMode,
} from './scmShared.js'
import { scmViewState } from './scmViewState.js'
import styles from './ScmView.module.css'

const VIEW_MODE_STORAGE_KEY = 'scm.viewMode'
const COMMIT_ACTION_STORAGE_KEY = 'scm.commitAction'
const SELECTED_REPO_STORAGE_KEY = 'scm.selectedRepo'

interface CommitAction {
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly command: string
}

interface PrimaryCommitAction {
  readonly label: string
  readonly command: string
  readonly disabled: boolean
}

/** The commit-button choices; the last one picked becomes the sticky default. */
const COMMIT_ACTIONS: readonly CommitAction[] = [
  {
    id: 'git.commit',
    label: localize('scm.commit', 'Commit'),
    icon: 'git-commit',
    command: 'git.commit',
  },
  {
    id: 'git.commitAmend',
    label: localize('scm.commitAmend', 'Commit (Amend)'),
    icon: 'git-commit',
    command: 'git.commitAmend',
  },
  {
    id: 'git.commitAndPush',
    label: localize('scm.commitAndPush', 'Commit & Push'),
    icon: 'push',
    command: 'git.commitAndPush',
  },
  {
    id: 'git.commitAndSync',
    label: localize('scm.commitAndSync', 'Commit & Sync'),
    icon: 'sync',
    command: 'git.commitAndSync',
  },
]
const DEFAULT_COMMIT_ACTION = COMMIT_ACTIONS[0]!

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
export function buildSnapshot(
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
          // Compact a single-subfolder chain ("a" → "a/b" → "a/b/c") into one
          // node: walk down while each folder holds exactly one subfolder and no
          // files. The node keeps the leaf path; its label shows the joined path.
          let leaf = f
          let displayName = f.name
          while (leaf.files.length === 0 && leaf.folders.size === 1) {
            const only = [...leaf.folders.values()][0]!
            displayName += `/${only.name}`
            leaf = only
          }
          const id = `folder:${g.id}/${leaf.path}`
          const folderNode: ScmNode = {
            kind: 'folder',
            id,
            groupId: g.id,
            path: leaf.path,
            name: displayName,
          }
          into.push(folderNode)
          parentMap.set(id, parent)
          collapsibleIds.push(id)
          const children: ScmNode[] = []
          childrenMap.set(id, children)
          addLevel(leaf, folderNode, children)
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

/**
 * Case-insensitive, separator-agnostic path key for matching SCM rows. Mirrors
 * scmPathKey — a self-contained SCM-domain key that only needs to agree with
 * itself, so it is intentionally not routed through IUriIdentityService.
 */

function pathKey(p: string): string {
  // eslint-disable-next-line no-restricted-syntax -- centralized SCM-domain key (see doc above)
  return p.replace(/\\/g, '/').toLowerCase()
}

/** Find the first file row in the snapshot whose resource matches `fsPath`. */
function findFileNode(
  snapshot: ScmSnapshot,
  fsPath: string,
): Extract<ScmNode, { kind: 'file' }> | undefined {
  const key = pathKey(fsPath)
  for (const children of snapshot.childrenMap.values()) {
    for (const node of children) {
      if (node.kind === 'file' && pathKey(node.resource.resourceUri) === key) return node
    }
  }
  return undefined
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
  getSelectedUris,
}: SharedRowProps & {
  node: Extract<ScmNode, { kind: 'file' }>
  providerId: string
  revision: number
  getSelectedUris: () => readonly string[]
}) {
  const commandService = useService(ICommandService)
  const editorGroupsService = useService(IEditorGroupsService)
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
  const canPreviewMarkdown = isMarkdownPreviewResource(uri)
  const openMarkdownPreview = (): void => {
    openMarkdownPreviewInGroup(
      editorGroupsService.activeGroup,
      new MarkdownPreviewInput(uri),
      false,
    )
  }
  const openMarkdownPreviewAction: ActionItem = {
    id: 'scm.openPreview',
    title: localize('scm.openPreview', 'Open Preview'),
    command: '',
    icon: 'open-preview',
  }
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
      {...resourceDragProps(() => selectionDragUris(uri.toString(), getSelectedUris()))}
    >
      <FileIcon resource={uri} className={styles['fileIcon']} isDirectory={false} size={16} />
      <span className={styles['resourceLabel']} style={decorationStyle(resource)}>
        {basename(resource.resourceUri)}
      </span>
      {node.dir ? <span className={styles['resourceDir']}>{node.dir}</span> : null}
      <span className={styles['resourceActions']}>
        {canPreviewMarkdown && (
          <ActionButton
            action={openMarkdownPreviewAction}
            onRun={(e) => {
              e.stopPropagation()
              openMarkdownPreview()
            }}
          />
        )}
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
              title: localize('scm.unstageChanges', 'Unstage Changes'),
              command: 'git.unstage',
              icon: 'remove',
            },
          },
        ]
      : [
          {
            action: {
              id: 'git.discard',
              title: localize('scm.discardChanges', 'Discard Changes'),
              command: 'git.discard',
              icon: 'discard',
            },
            isDir: true,
          },
          {
            action: {
              id: 'git.stage',
              title: localize('scm.stageChanges', 'Stage Changes'),
              command: 'git.stage',
              icon: 'add',
            },
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
      {expanded ? (
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          className={styles['chevron']}
          aria-hidden="true"
        />
      ) : (
        <ChevronRight
          size={16}
          strokeWidth={1.75}
          className={styles['chevron']}
          aria-hidden="true"
        />
      )}
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
  rootUri,
  indentPadding,
  isSelected,
  isFocused,
  expanded,
  hasChildren,
  revision,
}: SharedRowProps & {
  node: Extract<ScmNode, { kind: 'group' }>
  providerId: string
  rootUri: string | undefined
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
      <span className={styles['chevron']} aria-hidden="true">
        {hasChildren &&
          (expanded ? (
            <ChevronDown size={16} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={16} strokeWidth={1.75} />
          ))}
      </span>
      <span className={styles['groupLabel']}>{node.label}</span>
      <span className={styles['groupActions']}>
        {groupActions.map((a) => (
          <ActionButton
            key={a.id}
            action={a}
            onRun={(e) => {
              e.stopPropagation()
              void commandService.executeCommand(a.command, {
                rootUri,
                sourceControlId: providerId,
              })
            }}
          />
        ))}
      </span>
      <span className={styles['groupCount']}>{node.count}</span>
    </div>
  )
})

// --- Provider --------------------------------------------------------------

function ScmProviderView({ model, revision }: { model: IScmSourceControlModel; revision: number }) {
  const scm = useService(IScmService)
  const commandService = useService(ICommandService)
  const storage = useService(IStorageService)
  const inputValue = useObservable(model.inputValue)
  const placeholder = useObservable(model.inputPlaceholder)
  const acceptCommand = useObservable(model.acceptCommand)
  const groups = useObservable(model.groups)
  const viewMode = useObservable(scmViewState.viewMode)

  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number } | null>(null)
  const [stickyCommitId, setStickyCommitId] = useState<string>(DEFAULT_COMMIT_ACTION.id)
  const [isCommitting, setIsCommitting] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)

  // Restore the last-picked commit action so the button defaults to it.
  const restoredCommitRef = useRef(false)
  useEffect(() => {
    if (restoredCommitRef.current) return
    restoredCommitRef.current = true
    void storage.get<string>(COMMIT_ACTION_STORAGE_KEY, StorageScope.GLOBAL).then((stored) => {
      if (stored && COMMIT_ACTIONS.some((a) => a.id === stored)) setStickyCommitId(stored)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const stickyCommit = COMMIT_ACTIONS.find((a) => a.id === stickyCommitId) ?? DEFAULT_COMMIT_ACTION

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
  const treeRef = useRef<HTMLDivElement>(null)
  // Whether the last reveal request landed on a file row; decides whether
  // focusView should focus the tree (a row is selected) or the commit box.
  const revealHitRef = useRef(false)
  // Only one provider is mounted at a time, so it always owns the view's focus.
  useViewFocusable(
    'workbench.view.scm.main',
    useCallback(() => (revealHitRef.current ? treeRef.current : inputRef.current), []),
  )

  // Reveal the file requested by the show-SCM command: select + scroll its row,
  // then pull focus to the tree. `snapshot` is a dependency so a request issued
  // before the tree is built retries once the data lands. `handledRevealRef`
  // starts at 0 (ticks start at 1) so a request that arrived before this
  // provider mounted — the SCM-was-closed case — is still picked up.
  const revealRequest = useObservable(scmViewState.revealRequest)
  const handledRevealRef = useRef<number>(0)
  useEffect(() => {
    if (!revealRequest || revealRequest.tick === handledRevealRef.current) return
    if (revealRequest.fsPath === null) {
      handledRevealRef.current = revealRequest.tick
      revealHitRef.current = false
      return
    }
    const node = findFileNode(snapshotRef.current, revealRequest.fsPath)
    if (!node) return // snapshot not ready yet — retry when it next changes
    handledRevealRef.current = revealRequest.tick
    revealHitRef.current = true
    void treeModel.reveal(node).then(() => treeRef.current?.focus({ preventScroll: true }))
  }, [revealRequest, snapshot, treeModel])

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

  const runCommand = (command: ICommandDto | string): void => {
    const id = typeof command === 'string' ? command : command.command
    setIsCommitting(true)
    commandService
      .executeCommand(id, { rootUri: model.rootUri, sourceControlId: model.id })
      .finally(() => {
        setIsCommitting(false)
      })
  }

  const localChangeCount = useMemo(
    () => groups.reduce((total, group) => total + group.resources.get().length, 0),
    // dataRevision tracks resource mutations inside stable group objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, dataRevision],
  )
  const hasLocalChanges = localChangeCount > 0
  const isGitProvider = model.id === 'git'
  const primaryCommitAction = useMemo<PrimaryCommitAction | undefined>(() => {
    if (isGitProvider) {
      if (!hasLocalChanges) {
        if (!acceptCommand) {
          return {
            label: DEFAULT_COMMIT_ACTION.label,
            command: DEFAULT_COMMIT_ACTION.command,
            disabled: true,
          }
        }
        return {
          label: acceptCommand.title || localize('scm.commit', 'Commit'),
          command: acceptCommand.command,
          disabled: acceptCommand.disabled === true,
        }
      }
      return {
        label: stickyCommit.label,
        command: stickyCommit.command,
        disabled: false,
      }
    }
    if (!acceptCommand) return undefined
    return { label: acceptCommand.title, command: acceptCommand.command, disabled: false }
  }, [acceptCommand, hasLocalChanges, isGitProvider, stickyCommit])
  const showCommitMenuButton = isGitProvider

  const collapseAll = (): void => {
    const folderIds = snapshotRef.current.collapsibleIds.filter((id) => id.startsWith('folder:'))
    treeModel.setExpansion(folderIds.map((id) => [id, false] as const))
  }

  // Selected file URIs, read lazily at dragstart so a multi-selection drags all
  // of them. Stable identity (treeModel never changes) keeps ScmFileRow memoized.
  const getSelectedUris = useCallback((): string[] => {
    const ids = new Set(treeModel.selection)
    const out: string[] = []
    for (const children of snapshotRef.current.childrenMap.values()) {
      for (const n of children) {
        if (n.kind === 'file' && ids.has(n.id)) {
          out.push(URI.file(n.resource.resourceUri).toString())
        }
      }
    }
    return out
  }, [treeModel])

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
        <ScmGroupRow
          key={n.id}
          {...shared}
          node={n}
          providerId={model.id}
          rootUri={model.rootUri}
          revision={revision}
        />
      )
    if (n.kind === 'folder')
      return (
        <ScmFolderRow key={n.id} {...shared} node={n} rootUri={model.rootUri} revision={revision} />
      )
    return (
      <ScmFileRow
        key={n.id}
        {...shared}
        node={n}
        providerId={model.id}
        revision={revision}
        getSelectedUris={getSelectedUris}
      />
    )
  }

  // Collapse-all is driven from the title toolbar via a shared signal counter;
  // each increment (ignoring the initial value) collapses every folder.
  const collapseSignal = useObservable(scmViewState.collapseAllSignal)
  const seenSignalRef = useRef(collapseSignal)
  useEffect(() => {
    if (collapseSignal === seenSignalRef.current) return
    seenSignalRef.current = collapseSignal
    collapseAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseSignal])

  const openCommitMenu = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setCommitMenu({ x: rect.right - 200, y: rect.bottom + 2 })
  }

  const inputScope = useMemo(() => ({ scmProvider: model.id }), [model.id])
  const inputBoxActions = useMemo(
    () => menuActions(MenuId.ScmInputBox, inputScope, 'inline'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputScope, revision],
  )

  const commitRows = useMemo<OverflowRow[]>(
    () =>
      COMMIT_ACTIONS.map((a) => ({
        kind: 'item',
        id: a.id,
        label: a.label,
        icon: a.icon,
        run: () => {
          setStickyCommitId(a.id)
          void storage.set(COMMIT_ACTION_STORAGE_KEY, a.id, StorageScope.GLOBAL)
          runCommand(a.command)
        },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storage],
  )

  return (
    <section className={styles['provider']}>
      <div
        className={`${styles['commitInputWrapper']} ${isGenerating ? styles['generating'] : ''}`}
      >
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
              if (primaryCommitAction && !primaryCommitAction.disabled && !isCommitting) {
                runCommand(primaryCommitAction.command)
              }
            }
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault()
              treeRef.current?.focus({ preventScroll: true })
              // Give keyboard navigation an anchor: select the first row if none focused.
              if (!treeModel.focused) {
                const first = treeModel.getVisibleNodes()[0]
                if (first) treeModel.setSelection([first.id], first.id)
              }
            }
          }}
        />
        {inputBoxActions.length > 0 && (
          <span className={styles['inputBoxActions']}>
            {inputBoxActions.map((a) => (
              <ActionButton
                key={a.id}
                action={a}
                onRun={(e) => {
                  e.preventDefault()
                  setIsGenerating(true)
                  void commandService
                    .executeCommand(a.command, {
                      rootUri: model.rootUri,
                      sourceControlId: model.id,
                    })
                    .finally(() => {
                      setIsGenerating(false)
                    })
                }}
              />
            ))}
          </span>
        )}
      </div>
      {primaryCommitAction && (
        <div className={styles['commitBar']}>
          <button
            type="button"
            className={`${styles['commitButton']} ${
              showCommitMenuButton ? '' : styles['commitButtonOnly']
            } ${isCommitting ? styles['committing'] : ''}`}
            disabled={primaryCommitAction.disabled || isCommitting}
            onClick={() => runCommand(primaryCommitAction.command)}
          >
            <span className={styles['commitButtonLabel']}>{primaryCommitAction.label}</span>
          </button>
          {showCommitMenuButton && (
            <button
              type="button"
              className={styles['commitDropdown']}
              title={localize('scm.commitActions', 'Commit actions...')}
              disabled={isCommitting}
              onClick={openCommitMenu}
            >
              <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <Tree<ScmNode>
        model={treeModel}
        className={styles['tree'] ?? ''}
        rootRef={treeRef}
        virtualizationThreshold={Number.MAX_SAFE_INTEGER}
        indentBase={0}
        renderRow={renderRow}
        onActivate={(node, opts) => {
          const n = node.element
          if (n.kind !== 'file' || !n.resource.command) return
          if (opts.preview) {
            // Space previews the change without stealing focus from the list.
            void commandService.executeCommand(n.resource.command.command, n.resource, {
              preserveFocus: true,
            })
          } else {
            void commandService.executeCommand(n.resource.command.command, n.resource)
          }
        }}
      />

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

  // ScmView owns the IStorageService dependency, so it loads the persisted view
  // mode into the shared store on mount and writes it back on change. The title
  // toolbar flips the mode through `scmViewState`; the body just reads it.
  const restoredRef = useRef(false)
  useEffect(() => {
    let active = true
    void storage.get<ViewMode>(VIEW_MODE_STORAGE_KEY, StorageScope.GLOBAL).then((stored) => {
      if (active && (stored === 'list' || stored === 'tree')) scmViewState.setViewMode(stored)
      if (active) restoredRef.current = true
    })
    return () => {
      active = false
    }
  }, [storage])

  const viewMode = useObservable(scmViewState.viewMode)
  useEffect(() => {
    if (!restoredRef.current) return
    void storage.set(VIEW_MODE_STORAGE_KEY, viewMode, StorageScope.GLOBAL)
  }, [viewMode, storage])

  // Restore / persist the selected repo per workspace (repo sets differ per
  // workspace). Guarded so the default value doesn't overwrite storage on mount.
  const selectedRootUri = useObservable(scmViewState.selectedRepo)
  const restoredRepoRef = useRef(false)
  useEffect(() => {
    let active = true
    void storage.get<string>(SELECTED_REPO_STORAGE_KEY, StorageScope.WORKSPACE).then((stored) => {
      if (active && stored) scmViewState.setSelectedRepo(stored)
      if (active) restoredRepoRef.current = true
    })
    return () => {
      active = false
    }
  }, [storage])
  useEffect(() => {
    if (!restoredRepoRef.current || selectedRootUri === undefined) return
    void storage.set(SELECTED_REPO_STORAGE_KEY, selectedRootUri, StorageScope.WORKSPACE)
  }, [selectedRootUri, storage])

  const selected = sourceControls.find((sc) => sc.rootUri === selectedRootUri) ?? sourceControls[0]

  return (
    <div className={styles['scmView']} tabIndex={-1}>
      {!selected ? (
        <div className={styles['empty']}>
          {localize('scm.empty', 'No source control providers registered.')}
        </div>
      ) : (
        <ScmProviderView key={selected.handle} model={selected} revision={revision} />
      )}
    </div>
  )
}
