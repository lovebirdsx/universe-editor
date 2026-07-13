/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Changed files for one Swarm review version, rendered in SCM-style list/tree
 *  modes through the shared Tree model and generic changed-file tree builder.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Folder,
  FolderOpen,
  FolderTree,
  List,
} from 'lucide-react'
import { URI, localize } from '@universe-editor/platform'
import type { SwarmReviewFileDto } from '@universe-editor/extensions-common'
import {
  IconButton,
  Tree,
  TreeModel,
  useOwnedTreeModel,
  type ITreeDataSource,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import { buildFileTree, type FileTreeNode } from '../../services/gitGraph/fileTree.js'
import type { SwarmReviewFilesViewMode } from '../../services/swarm/swarmViewState.js'
import { FileIcon } from '../files/fileIconTheme.js'
import styles from './SwarmReviewEditor.module.css'

type SwarmFileNode =
  | { readonly kind: 'folder'; readonly id: string; readonly name: string; readonly path: string }
  | {
      readonly kind: 'file'
      readonly id: string
      readonly name: string
      readonly dir: string
      readonly file: SwarmReviewFileDto
    }

interface SwarmFilesSnapshot {
  readonly roots: SwarmFileNode[]
  readonly childrenMap: Map<string, SwarmFileNode[]>
  readonly parentMap: Map<string, SwarmFileNode>
  readonly folderIds: string[]
}

const EMPTY_SNAPSHOT: SwarmFilesSnapshot = {
  roots: [],
  childrenMap: new Map(),
  parentMap: new Map(),
  folderIds: [],
}

function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf('/')
  return index === -1
    ? { name: path, dir: '' }
    : { name: path.slice(index + 1), dir: path.slice(0, index) }
}

function fileNode(file: SwarmReviewFileDto, name?: string): SwarmFileNode {
  const path = splitPath(file.path)
  return {
    kind: 'file',
    id: `file:${file.depotFile}`,
    name: name ?? path.name,
    dir: path.dir,
    file,
  }
}

function buildSnapshot(
  files: readonly SwarmReviewFileDto[],
  viewMode: SwarmReviewFilesViewMode,
): SwarmFilesSnapshot {
  if (viewMode === 'list') {
    return { ...EMPTY_SNAPSHOT, roots: files.map((file) => fileNode(file)) }
  }

  const roots: SwarmFileNode[] = []
  const childrenMap = new Map<string, SwarmFileNode[]>()
  const parentMap = new Map<string, SwarmFileNode>()
  const folderIds: string[] = []

  const append = (
    nodes: readonly FileTreeNode<SwarmReviewFileDto>[],
    into: SwarmFileNode[],
    parent?: SwarmFileNode,
  ): void => {
    for (const node of nodes) {
      if (node.kind === 'file') {
        const child = fileNode(node.file, node.name)
        into.push(child)
        if (parent) parentMap.set(child.id, parent)
        continue
      }
      const folder: SwarmFileNode = {
        kind: 'folder',
        id: `folder:${node.path}`,
        name: node.name,
        path: node.path,
      }
      into.push(folder)
      folderIds.push(folder.id)
      if (parent) parentMap.set(folder.id, parent)
      const children: SwarmFileNode[] = []
      childrenMap.set(folder.id, children)
      append(node.children, children, folder)
    }
  }

  append(buildFileTree(files), roots)
  return { roots, childrenMap, parentMap, folderIds }
}

function statusClass(status: string): string | undefined {
  switch (status.charAt(0)) {
    case 'A':
      return styles['statusAdded']
    case 'D':
      return styles['statusDeleted']
    default:
      return styles['statusModified']
  }
}

function fileResource(file: SwarmReviewFileDto): URI {
  return URI.from({ scheme: 'swarm', path: `/${file.path}` })
}

export interface SwarmReviewFilesProps {
  readonly files: readonly SwarmReviewFileDto[]
  readonly viewMode: SwarmReviewFilesViewMode
  readonly onViewModeChange?: ((mode: SwarmReviewFilesViewMode) => void) | undefined
  readonly onOpenFile: (file: SwarmReviewFileDto) => void
}

export function SwarmReviewFiles({
  files,
  viewMode,
  onViewModeChange,
  onOpenFile,
}: SwarmReviewFilesProps) {
  const snapshotRef = useRef<SwarmFilesSnapshot>(EMPTY_SNAPSHOT)
  const treeModel = useOwnedTreeModel<SwarmFileNode>(() => {
    const dataSource: ITreeDataSource<SwarmFileNode> = {
      getId: (node) => node.id,
      hasChildren: (node) => (snapshotRef.current.childrenMap.get(node.id)?.length ?? 0) > 0,
      getChildren: (node) => snapshotRef.current.childrenMap.get(node.id) ?? [],
      getRoots: () => snapshotRef.current.roots,
      getParent: (node) => snapshotRef.current.parentMap.get(node.id) ?? null,
    }
    return new TreeModel<SwarmFileNode>({
      dataSource,
      defaultExpanded: (node) => node.kind === 'folder',
    })
  })

  const snapshot = useMemo(() => buildSnapshot(files, viewMode), [files, viewMode])
  snapshotRef.current = snapshot
  useLayoutEffect(() => treeModel.refresh(), [snapshot, treeModel])

  const collapseAll = (): void => {
    treeModel.setExpansion(snapshotRef.current.folderIds.map((id) => [id, false] as const))
  }

  const renderRow = (ctx: ITreeRowRenderContext<SwarmFileNode>) => {
    const node = ctx.node.element
    const className = [
      styles['fileTreeRow'],
      ctx.isSelected && styles['fileTreeRowSelected'],
      ctx.isFocused && styles['fileTreeRowFocused'],
    ]
      .filter(Boolean)
      .join(' ')
    const style = { paddingLeft: ctx.indentPadding, ...(ctx.style ?? {}) }

    if (node.kind === 'folder') {
      return (
        <div
          key={node.id}
          data-row-key={node.id}
          data-testid="swarm-review-file-folder"
          role="treeitem"
          aria-expanded={ctx.node.expanded}
          className={className}
          style={style}
          title={node.path}
          onClick={ctx.onClickRow}
        >
          <button
            type="button"
            className={styles['fileTreeChevron']}
            aria-label={localize('swarm.files.toggleFolder', 'Toggle {name}', { name: node.name })}
            onClick={(event) => {
              event.stopPropagation()
              ctx.onToggle()
            }}
          >
            {ctx.node.expanded ? (
              <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
          <span className={styles['fileTreeIcon']} aria-hidden="true">
            {ctx.node.expanded ? (
              <FolderOpen size={14} strokeWidth={1.75} />
            ) : (
              <Folder size={14} strokeWidth={1.75} />
            )}
          </span>
          <span className={styles['fileTreeName']}>{node.name}</span>
        </div>
      )
    }

    return (
      <div
        key={node.id}
        data-row-key={node.id}
        data-testid="swarm-review-file-row"
        role="treeitem"
        className={className}
        style={style}
        title={node.file.path}
        onClick={ctx.onClickRow}
      >
        <span className={styles['fileTreeChevronGap']} />
        <FileIcon
          resource={fileResource(node.file)}
          isDirectory={false}
          className={styles['fileTreeIcon']}
          size={14}
        />
        <span className={styles['fileTreeName']}>{node.name}</span>
        {viewMode === 'list' && node.dir && (
          <span className={styles['fileTreeDir']}>{node.dir}</span>
        )}
        <span className={`${styles['status']} ${statusClass(node.file.status) ?? ''}`}>
          {node.file.status}
        </span>
      </div>
    )
  }

  return (
    <section className={styles['filesPanel']}>
      <div className={styles['filesHeader']}>
        <span>
          {localize('swarm.files', 'Files')} ({files.length})
        </span>
        <span className={styles['filesHeaderSpacer']} />
        {viewMode === 'tree' && (
          <IconButton
            label={localize('swarm.files.collapseAll', 'Collapse All')}
            size={22}
            onClick={collapseAll}
          >
            <ChevronsDownUp size={14} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
        )}
        <span className={styles['viewModeControl']}>
          <IconButton
            label={localize('swarm.files.viewAsList', 'View as List')}
            size={22}
            active={viewMode === 'list'}
            aria-pressed={viewMode === 'list'}
            onClick={() => onViewModeChange?.('list')}
          >
            <List size={14} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
          <IconButton
            label={localize('swarm.files.viewAsTree', 'View as Tree')}
            size={22}
            active={viewMode === 'tree'}
            aria-pressed={viewMode === 'tree'}
            onClick={() => onViewModeChange?.('tree')}
          >
            <FolderTree size={14} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
        </span>
      </div>
      <Tree<SwarmFileNode>
        model={treeModel}
        className={styles['fileTree'] ?? ''}
        virtualListClassName={styles['fileTreeVirtual'] ?? ''}
        ariaLabel={localize('swarm.files', 'Files')}
        rowHeight={22}
        indentWidth={12}
        renderRow={renderRow}
        onActivate={(node) => {
          if (node.element.kind === 'file') onOpenFile(node.element.file)
        }}
      />
    </section>
  )
}
