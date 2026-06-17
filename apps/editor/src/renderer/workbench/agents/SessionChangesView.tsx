/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionChangesView — the "Session Changes" viewlet. Lists the whole-file
 *  modifications the active agent session made (tracked via ISessionChange
 *  TrackerService), SCM-CHANGES style: a list or tree of changed files. Single-
 *  click previews a whole-file diff (reuses the preview tab); double-click pins
 *  it. The baseline is reconstructed from the session's edits vs. the current
 *  on-disk content.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileSymlink } from 'lucide-react'
import {
  IEditorResolverService,
  IEditorService,
  IStorageService,
  IWorkspaceService,
  StorageScope,
  localize,
  observableValue,
  type IObservable,
} from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import {
  ISessionChangeTrackerService,
  type SessionFileChange,
} from '../../services/acp/sessionChangeTracker.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { FileIcon } from '../files/fileIconTheme.js'
import { basenameOfResource, dirnameOfResource } from '../files/resourceInfo.js'
import { sessionChangesViewState, type SessionChangesViewMode } from './sessionChangesViewState.js'
import styles from './SessionChangesView.module.css'

const EMPTY_OBS: IObservable<readonly SessionFileChange[]> = observableValue(
  'acp.sessionChanges.viewEmpty',
  [],
)

const VIEW_MODE_STORAGE_KEY = 'acp.sessionChanges.viewMode'

export function SessionChangesView() {
  const sessions = useService(IAcpSessionService)
  const tracker = useService(ISessionChangeTrackerService)
  const storage = useService(IStorageService)
  const session = useObservable(sessions.activeSession)
  const sessionId = session?.id
  const changes = useObservable(sessionId ? tracker.changesFor(sessionId) : EMPTY_OBS)
  const viewMode = useObservable(sessionChangesViewState.viewMode)

  // This view owns the IStorageService dependency, so it restores the persisted
  // view mode into the shared store on mount and writes it back on change. The
  // title toolbar flips the mode through `sessionChangesViewState`.
  const restoredRef = useRef(false)
  useEffect(() => {
    let active = true
    void storage
      .get<SessionChangesViewMode>(VIEW_MODE_STORAGE_KEY, StorageScope.GLOBAL)
      .then((stored) => {
        if (active && (stored === 'list' || stored === 'tree')) {
          sessionChangesViewState.setViewMode(stored)
        }
        if (active) restoredRef.current = true
      })
    return () => {
      active = false
    }
  }, [storage])
  useEffect(() => {
    if (!restoredRef.current) return
    void storage.set(VIEW_MODE_STORAGE_KEY, viewMode, StorageScope.GLOBAL)
  }, [viewMode, storage])

  if (!session) {
    return <Empty hint={localize('acp.changes.noSession', 'No active agent session.')} />
  }
  if (changes.length === 0) {
    return (
      <Empty hint={localize('acp.changes.none', 'This session has not modified any files yet.')} />
    )
  }
  return (
    <div className={styles['view']} data-testid="acp-changes-view">
      {viewMode === 'tree' ? (
        <ChangeTree changes={changes} />
      ) : (
        <ChangeFlatList changes={changes} />
      )}
    </div>
  )
}

function useOpenChange(): (c: SessionFileChange, preview: boolean) => void {
  const editorService = useService(IEditorService)
  return (c, preview) => {
    void editorService.openEditor(new DiffEditorInput(c.uri, c.baseline, c.current), {
      pinned: !preview,
    })
  }
}

function useOpenFile(): (c: SessionFileChange) => void {
  const resolver = useService(IEditorResolverService)
  return (c) => {
    void resolver.openEditor(c.uri, { pinned: true })
  }
}

function ChangeFlatList({ changes }: { changes: readonly SessionFileChange[] }) {
  const open = useOpenChange()
  const openFile = useOpenFile()
  return (
    <ul className={styles['list']}>
      {changes.map((c) => (
        <ChangeRow key={c.path} change={c} depth={0} showDir onOpen={open} onOpenFile={openFile} />
      ))}
    </ul>
  )
}

interface TreeFolder {
  readonly name: string
  readonly path: string
  readonly folders: Map<string, TreeFolder>
  readonly files: SessionFileChange[]
}

function newFolder(name: string, path: string): TreeFolder {
  return { name, path, folders: new Map(), files: [] }
}

function buildTree(changes: readonly SessionFileChange[], rootDir: string): TreeFolder {
  const root = newFolder('', '')
  const normRoot = rootDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const segmentsOf = (c: SessionFileChange): string[] => {
    let dir = dirnameOfResource(c.uri).replace(/\\/g, '/')
    if (normRoot.length > 0 && dir.startsWith(`${normRoot}/`)) dir = dir.slice(normRoot.length + 1)
    else if (dir === normRoot) dir = ''
    return dir.length === 0 ? [] : dir.split('/').filter((s) => s.length > 0)
  }
  for (const c of changes) {
    let node = root
    let acc = ''
    for (const seg of segmentsOf(c)) {
      acc = acc.length === 0 ? seg : `${acc}/${seg}`
      let child = node.folders.get(seg)
      if (!child) {
        child = newFolder(seg, acc)
        node.folders.set(seg, child)
      }
      node = child
    }
    node.files.push(c)
  }
  return root
}

/** Walk down a single-subfolder/no-file chain (a → a/b → a/b/c), returning the
 *  leaf node plus the joined display name. The root is never compressed, so a
 *  shared top-level prefix stays visible as its own folder row. */
function compressFolder(f: TreeFolder): { leaf: TreeFolder; displayName: string } {
  let leaf = f
  let displayName = f.name
  while (leaf.files.length === 0 && leaf.folders.size === 1) {
    const only = [...leaf.folders.values()][0]!
    displayName = `${displayName}/${only.name}`
    leaf = only
  }
  return { leaf, displayName }
}

function ChangeTree({ changes }: { changes: readonly SessionFileChange[] }) {
  const open = useOpenChange()
  const openFile = useOpenFile()
  const workspace = useService(IWorkspaceService)
  const rootDir = workspace.current?.folder.fsPath ?? ''
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const root = buildTree(changes, rootDir)
  return (
    <ul className={styles['list']}>
      <TreeFolderRows
        folder={root}
        depth={0}
        collapsed={collapsed}
        onToggle={toggle}
        onOpen={open}
        onOpenFile={openFile}
      />
    </ul>
  )
}

function TreeFolderRows({
  folder,
  depth,
  collapsed,
  onToggle,
  onOpen,
  onOpenFile,
}: {
  folder: TreeFolder
  depth: number
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpen: (c: SessionFileChange, preview: boolean) => void
  onOpenFile: (c: SessionFileChange) => void
}) {
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
  const files = [...folder.files].sort((a, b) =>
    basenameOfResource(a.uri).localeCompare(basenameOfResource(b.uri)),
  )
  return (
    <>
      {folders.map((f) => {
        const { leaf, displayName } = compressFolder(f)
        const isCollapsed = collapsed.has(leaf.path)
        return (
          <li key={`d:${leaf.path}`}>
            <div
              className={styles['folderRow']}
              style={{ paddingLeft: 8 + depth * 12 }}
              data-testid="acp-changes-folder"
              onClick={() => onToggle(leaf.path)}
              title={leaf.path}
            >
              {isCollapsed ? (
                <ChevronRight size={16} strokeWidth={1.75} className={styles['chevron']} />
              ) : (
                <ChevronDown size={16} strokeWidth={1.75} className={styles['chevron']} />
              )}
              <span className={styles['folderName']}>{displayName}</span>
            </div>
            {!isCollapsed && (
              <ul className={styles['list']}>
                <TreeFolderRows
                  folder={leaf}
                  depth={depth + 1}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onOpenFile={onOpenFile}
                />
              </ul>
            )}
          </li>
        )
      })}
      {files.map((c) => (
        <ChangeRow key={c.path} change={c} depth={depth} onOpen={onOpen} onOpenFile={onOpenFile} />
      ))}
    </>
  )
}

function ChangeRow({
  change,
  depth,
  showDir,
  onOpen,
  onOpenFile,
}: {
  change: SessionFileChange
  depth: number
  showDir?: boolean
  onOpen: (c: SessionFileChange, preview: boolean) => void
  onOpenFile: (c: SessionFileChange) => void
}) {
  const isDeleted = change.status === 'deleted'
  return (
    <li
      className={styles['row']}
      style={{ paddingLeft: 8 + depth * 12 }}
      data-status={change.status}
      data-testid="acp-changes-row"
      onClick={isDeleted ? undefined : () => onOpen(change, true)}
      onDoubleClick={isDeleted ? undefined : () => onOpen(change, false)}
      title={change.path}
    >
      <FileIcon resource={change.uri} isDirectory={false} className={styles['icon']} />
      <span className={styles['name']}>{basenameOfResource(change.uri)}</span>
      {showDir && <span className={styles['dir']}>{dirnameOfResource(change.uri)}</span>}
      {change.status !== 'deleted' && (
        <span className={styles['actions']}>
          <button
            type="button"
            className={styles['actionButton']}
            title={localize('acp.changes.openFile', 'Open File')}
            data-testid="acp-changes-open-file"
            onClick={(e) => {
              e.stopPropagation()
              onOpenFile(change)
            }}
          >
            <FileSymlink size={16} strokeWidth={1.6} />
          </button>
        </span>
      )}
      <span className={styles['badge']} data-status={change.status} aria-hidden="true">
        {statusLetter(change.status)}
      </span>
    </li>
  )
}

function statusLetter(status: SessionFileChange['status']): string {
  switch (status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'degraded':
      return '!'
    default:
      return 'M'
  }
}

function Empty({ hint }: { hint: string }) {
  return (
    <div className={styles['empty']} data-testid="acp-changes-empty">
      {hint}
    </div>
  )
}
