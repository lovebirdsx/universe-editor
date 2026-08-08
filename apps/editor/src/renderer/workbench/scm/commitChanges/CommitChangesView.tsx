/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CommitChangesView — sidebar view (inside the SCM container) showing one
 *  commit's changed files, fed by the `_workbench.showCommitChanges` bridge
 *  command through commitChangesViewState. Clicking a file row executes the
 *  payload's openExternalCommand (e.g. git-graph.openFileDiff) to open the
 *  single-file diff; an inline "Open File" button opens the working-copy file.
 *--------------------------------------------------------------------------------------------*/

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { ICommandService, IEditorResolverService, localize, URI } from '@universe-editor/platform'
import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'
import {
  Tree,
  TreeModel,
  useOwnedTreeModel,
  type ITreeDataSource,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { FileIcon } from '../../files/fileIconTheme.js'
import { useObservable, useService } from '../../useService.js'
import { ActionButton } from '../scmShared.js'
import {
  buildCommitChangesSnapshot,
  findFileNode,
  type CommitChangesNode,
  type CommitChangesSnapshot,
} from './buildSnapshot.js'
import { commitChangesViewState } from './viewState.js'
import styles from './CommitChangesView.module.css'

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

function formatAuthorDate(unixSeconds: number): string {
  if (!unixSeconds) return ''
  return new Date(unixSeconds * 1000).toLocaleString()
}

function statusClass(status: string): string | undefined {
  return styles[`status${status.charAt(0)}`]
}

/** Plain click selects and runs `onPlain`; shift/ctrl follow the shared tree
 *  selection semantics (same helper shape as ScmView's rows). */
function rowClick(
  model: TreeModel<CommitChangesNode>,
  node: CommitChangesNode,
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

interface SharedRowProps {
  model: TreeModel<CommitChangesNode>
  indentPadding: number
  isSelected: boolean
  isFocused: boolean
  expanded: boolean
  /** Virtualization positioning style from <Tree>; merged onto the row root. */
  rowStyle?: CSSProperties
}

const FileRow = memo(function FileRow({
  model,
  node,
  indentPadding,
  isSelected,
  isFocused,
  openExternalCommand,
  rowStyle,
}: SharedRowProps & {
  node: Extract<CommitChangesNode, { kind: 'file' }>
  openExternalCommand: string
}) {
  const commandService = useService(ICommandService)
  const editorResolverService = useService(IEditorResolverService)
  const entry = node.entry

  const fileUri = useMemo(
    () => (entry.resourceUri !== null ? URI.parse(entry.resourceUri) : null),
    [entry.resourceUri],
  )
  // FileIcon only needs the name/extension for language + icon resolution, so a
  // deleted file (resourceUri null) still gets its glyph from the path.
  const iconUri = useMemo(() => fileUri ?? URI.file(entry.path), [fileUri, entry.path])

  const openDiff = (): void => {
    void commandService.executeCommand(openExternalCommand, entry.args)
  }
  const openFile = (): void => {
    if (fileUri) void editorResolverService.openEditor(fileUri, { pinned: true })
  }

  const tooltip = entry.oldPath !== null ? `${entry.oldPath} → ${entry.path}` : entry.path
  const openFileAction = {
    id: 'commitChanges.openFile',
    title: localize('scm.openFile', 'Open File'),
    command: '',
    icon: 'go-to-file',
  }

  return (
    <li
      data-row-key={node.id}
      role="treeitem"
      aria-selected={isSelected}
      className={rowClassName(styles['file'] ?? '', isSelected, isFocused)}
      style={
        rowStyle ? { paddingLeft: indentPadding, ...rowStyle } : { paddingLeft: indentPadding }
      }
      data-tooltip={tooltip}
      onClick={(e) => rowClick(model, node, e, openDiff)}
      onDoubleClick={openDiff}
    >
      <FileIcon resource={iconUri} className={styles['fileIcon']} isDirectory={false} size={16} />
      {entry.oldPath !== null && (
        <>
          <span className={styles['renameFrom']}>{basename(entry.oldPath)}</span>
          <span className={styles['renameArrow']}>→</span>
        </>
      )}
      <span className={styles['fileLabel']}>{basename(entry.path)}</span>
      {node.dir ? <span className={styles['fileDir']}>{node.dir}</span> : null}
      <span className={styles['fileActions']}>
        {fileUri !== null && (
          <ActionButton
            action={openFileAction}
            onRun={(e) => {
              e.stopPropagation()
              openFile()
            }}
          />
        )}
      </span>
      <span
        className={`${styles['statusLetter'] ?? ''} ${statusClass(entry.status) ?? ''}`}
        data-status={entry.status.charAt(0)}
      >
        {entry.status.charAt(0)}
      </span>
    </li>
  )
})

const FolderRow = memo(function FolderRow({
  model,
  node,
  indentPadding,
  isSelected,
  isFocused,
  expanded,
  onToggle,
  rowStyle,
}: SharedRowProps & {
  node: Extract<CommitChangesNode, { kind: 'folder' }>
  onToggle: (node: Extract<CommitChangesNode, { kind: 'folder' }>) => void
}) {
  const folderUri = useMemo(() => URI.file(node.name), [node.name])
  return (
    <li
      data-row-key={node.id}
      role="treeitem"
      aria-expanded={expanded}
      aria-selected={isSelected}
      className={rowClassName(styles['folder'] ?? '', isSelected, isFocused)}
      style={
        rowStyle ? { paddingLeft: indentPadding, ...rowStyle } : { paddingLeft: indentPadding }
      }
      onClick={(e) => rowClick(model, node, e, () => onToggle(node))}
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
    </li>
  )
})

function CommitChangesContent({ payload }: { payload: ShowCommitChangesPayload }) {
  const commandService = useService(ICommandService)
  // Collapse state lives outside the TreeModel: the snapshot drops a collapsed
  // folder's children outright, so a row click just edits this set and the
  // rebuilt snapshot re-renders the tree. The set starts empty for every show()
  // because the view remounts this component per tick.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  const snapshotRef = useRef<CommitChangesSnapshot>({
    roots: [],
    childrenMap: new Map(),
    parentMap: new Map(),
  })
  const treeModel = useOwnedTreeModel<CommitChangesNode>(() => {
    const dataSource: ITreeDataSource<CommitChangesNode> = {
      getId: (n) => n.id,
      hasChildren: (n) => (snapshotRef.current.childrenMap.get(n.id)?.length ?? 0) > 0,
      getChildren: (n) => snapshotRef.current.childrenMap.get(n.id) ?? [],
      getRoots: () => snapshotRef.current.roots,
      getParent: (n) => snapshotRef.current.parentMap.get(n.id) ?? null,
    }
    return new TreeModel<CommitChangesNode>({
      dataSource,
      defaultExpanded: (n) => n.kind === 'folder',
    })
  })

  const snapshot = useMemo(
    () => buildCommitChangesSnapshot(payload.files, collapsed),
    [payload.files, collapsed],
  )
  snapshotRef.current = snapshot
  useLayoutEffect(() => {
    treeModel.refresh()
  }, [snapshot, treeModel])

  // Reveal the file the payload points at (blame / timeline entry points):
  // select + scroll it into view without pulling DOM focus into the tree.
  // `snapshot` is a dependency so a reveal issued before the tree has content
  // retries once data lands.
  const revealDoneRef = useRef(false)
  useEffect(() => {
    if (revealDoneRef.current) return
    const revealPath = payload.revealPath
    if (revealPath === undefined) {
      revealDoneRef.current = true
      return
    }
    const node = findFileNode(snapshotRef.current, revealPath)
    if (!node) return
    revealDoneRef.current = true
    void treeModel.reveal(node)
  }, [snapshot, treeModel, payload.revealPath])

  const toggleFolder = (node: Extract<CommitChangesNode, { kind: 'folder' }>): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(node.path)) next.delete(node.path)
      else next.add(node.path)
      return next
    })
  }

  const renderRow = (ctx: ITreeRowRenderContext<CommitChangesNode>) => {
    const n = ctx.node.element
    const shared = {
      model: treeModel,
      indentPadding: ctx.indentPadding,
      isSelected: ctx.isSelected,
      isFocused: ctx.isFocused,
      expanded: ctx.node.expanded,
      ...(ctx.style !== undefined ? { rowStyle: ctx.style } : {}),
    }
    if (n.kind === 'folder') {
      return <FolderRow key={n.id} {...shared} node={n} onToggle={toggleFolder} />
    }
    return (
      <FileRow key={n.id} {...shared} node={n} openExternalCommand={payload.openExternalCommand} />
    )
  }

  const metadata = payload.metadata
  const metaLine = [
    ...(metadata?.author !== undefined ? [metadata.author] : []),
    ...(metadata?.authorDate !== undefined ? [formatAuthorDate(metadata.authorDate)] : []),
  ].join(' · ')

  return (
    <div className={styles['content']}>
      <div className={styles['header']}>
        <div
          className={styles['title']}
          data-tooltip={payload.title}
          data-testid="commitChanges-title"
        >
          {payload.title}
        </div>
        {metaLine !== '' && (
          <div className={styles['meta']} data-testid="commitChanges-meta">
            {metaLine}
          </div>
        )}
        {metadata?.parents !== undefined && metadata.parents.length > 0 && (
          <div className={styles['parents']} data-testid="commitChanges-parents">
            {localize('commitChanges.parents', 'Parents: {parents}', {
              parents: metadata.parents.map(shortHash).join(', '),
            })}
          </div>
        )}
        {metadata?.message !== undefined && metadata.message !== '' && (
          <pre className={styles['message']} data-testid="commitChanges-message">
            {metadata.message}
          </pre>
        )}
      </div>
      <Tree<CommitChangesNode>
        model={treeModel}
        className={styles['tree'] ?? ''}
        virtualListClassName={styles['virtualList'] ?? ''}
        ariaLabel={localize('commitChanges.treeLabel', 'Changed files')}
        indentBase={0}
        renderRow={renderRow}
        onActivate={(node) => {
          // Enter / Space on a file row runs the same command as a click; a
          // folder keeps the Tree's built-in Enter toggle.
          const n = node.element
          if (n.kind === 'file') {
            void commandService.executeCommand(payload.openExternalCommand, n.entry.args)
          }
        }}
      />
    </div>
  )
}

export function CommitChangesView() {
  const payload = useObservable(commitChangesViewState.payload)
  const tick = useObservable(commitChangesViewState.tick)

  return (
    <div className={styles['view']} tabIndex={-1} data-testid="commitChanges-view">
      {payload === null ? (
        <div className={styles['empty']}>
          {localize(
            'commitChanges.empty',
            'Select a commit from Blame, Timeline or Graph to view its changes.',
          )}
        </div>
      ) : (
        // Remount per show(): resets the collapsed set and re-triggers reveal
        // even when the same commit is shown twice in a row.
        <CommitChangesContent key={tick} payload={payload} />
      )}
    </div>
  )
}
