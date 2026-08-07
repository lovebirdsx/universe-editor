/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionChangesView — the "Session Changes" viewlet. Lists the whole-file
 *  modifications the active agent session made (tracked via ISessionChange
 *  TrackerService), SCM-CHANGES style: a list or tree of changed files. Single-
 *  click previews a whole-file diff (reuses the preview tab); double-click pins
 *  it. The baseline is the pinned pre-edit snapshot captured at first touch
 *  (agent-reported, or git HEAD for watched entries), diffed vs. the current
 *  on-disk content.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, EyeOff, FileSymlink } from 'lucide-react'
import {
  IEditorResolverService,
  IEditorService,
  IStorageService,
  IUriIdentityService,
  IWorkspaceService,
  StorageScope,
  localize,
  observableValue,
  type IObservable,
  type IUriIdentityService as UriIdentity,
} from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { resourceDragProps, useScrollRestore } from '@universe-editor/workbench-ui'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import {
  ISessionChangeTrackerService,
  type SessionFileChange,
} from '../../services/acp/session/sessionChangeTracker.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { FileIcon } from '../files/fileIconTheme.js'
import { ResourcePreviewButton } from '../files/ResourcePreviewButton.js'
import { basenameOfResource, dirnameOfResource } from '../files/resourceInfo.js'
import { sessionChangesViewState, type SessionChangesViewMode } from './sessionChangesViewState.js'
import styles from './SessionChangesView.module.css'

const EMPTY_OBS: IObservable<readonly SessionFileChange[]> = observableValue(
  'acp.sessionChanges.viewEmpty',
  [],
)

const EMPTY_ID_OBS: IObservable<string | undefined> = observableValue(
  'acp.sessionChanges.viewEmptyId',
  undefined,
)

const VIEW_MODE_STORAGE_KEY = 'acp.sessionChanges.viewMode'

export function SessionChangesView() {
  const sessions = useService(IAcpSessionService)
  const tracker = useService(ISessionChangeTrackerService)
  const storage = useService(IStorageService)
  const session = useObservable(sessions.activeSession)
  // change tracker 以 agent 颁发的 sessionIdOnAgent 为 key 记录改动；连接完成前它是
  // undefined，此时无改动可显示。observe 它以便连接就绪后自动刷新。
  const sessionIdOnAgent = useObservable(session?.sessionIdOnAgent ?? EMPTY_ID_OBS)
  const changes = useObservable(sessionIdOnAgent ? tracker.changesFor(sessionIdOnAgent) : EMPTY_OBS)
  const viewMode = useObservable(sessionChangesViewState.viewMode)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  useScrollRestore(
    'sessionChanges',
    useCallback(() => scrollRef.current, []),
  )

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
    <div className={styles['view']} data-testid="acp-changes-view" ref={scrollRef}>
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
    void editorService.openEditor(
      new DiffEditorInput(c.uri, c.baseline, c.current, undefined, c.uri, true),
      {
        pinned: !preview,
      },
    )
  }
}

function useOpenFile(): (c: SessionFileChange) => void {
  const resolver = useService(IEditorResolverService)
  return (c) => {
    void resolver.openEditor(c.uri, { pinned: true })
  }
}

/** Dismiss a watched (inferred) entry — the user judged it their own change. */
function useDismissWatched(): (c: SessionFileChange) => void {
  const sessions = useService(IAcpSessionService)
  const tracker = useService(ISessionChangeTrackerService)
  return (c) => {
    const sid = sessions.activeSession.get()?.sessionIdOnAgent.get()
    if (sid !== undefined) tracker.dismissWatched(sid, c.path)
  }
}

function ChangeFlatList({ changes }: { changes: readonly SessionFileChange[] }) {
  const open = useOpenChange()
  const openFile = useOpenFile()
  const dismiss = useDismissWatched()
  return (
    <ul className={styles['list']}>
      {changes.map((c) => (
        <ChangeRow
          key={c.path}
          change={c}
          depth={0}
          showDir
          onOpen={open}
          onOpenFile={openFile}
          onDismiss={dismiss}
        />
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

function buildTree(
  changes: readonly SessionFileChange[],
  rootDir: string,
  uriIdentity: UriIdentity,
): TreeFolder {
  const root = newFolder('', '')
  const segmentsOf = (c: SessionFileChange): string[] => {
    const dir = dirnameOfResource(c.uri).replace(/\\/g, '/')
    // Platform-aware relativization: an agent-reported path whose drive-letter
    // casing differs from the workspace folder still groups under the root.
    const rel = rootDir.length > 0 ? uriIdentity.relativePathUnder(rootDir, dir) : null
    const effective = rel ?? dir
    return effective.length === 0 ? [] : effective.split('/').filter((s) => s.length > 0)
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
  const dismiss = useDismissWatched()
  const workspace = useService(IWorkspaceService)
  const uriIdentity = useService(IUriIdentityService)
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
  const root = buildTree(changes, rootDir, uriIdentity)
  return (
    <ul className={styles['list']}>
      <TreeFolderRows
        folder={root}
        depth={0}
        collapsed={collapsed}
        onToggle={toggle}
        onOpen={open}
        onOpenFile={openFile}
        onDismiss={dismiss}
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
  onDismiss,
}: {
  folder: TreeFolder
  depth: number
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpen: (c: SessionFileChange, preview: boolean) => void
  onOpenFile: (c: SessionFileChange) => void
  onDismiss: (c: SessionFileChange) => void
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
              data-tooltip={leaf.path}
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
                  onDismiss={onDismiss}
                />
              </ul>
            )}
          </li>
        )
      })}
      {files.map((c) => (
        <ChangeRow
          key={c.path}
          change={c}
          depth={depth}
          onOpen={onOpen}
          onOpenFile={onOpenFile}
          onDismiss={onDismiss}
        />
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
  onDismiss,
}: {
  change: SessionFileChange
  depth: number
  showDir?: boolean
  onOpen: (c: SessionFileChange, preview: boolean) => void
  onOpenFile: (c: SessionFileChange) => void
  onDismiss: (c: SessionFileChange) => void
}) {
  const inferred = change.origin === 'watched'
  return (
    <li
      className={styles['row']}
      style={{ paddingLeft: 8 + depth * 12 }}
      data-status={change.status}
      data-testid="acp-changes-row"
      onClick={() => onOpen(change, true)}
      onDoubleClick={() => onOpen(change, false)}
      data-tooltip={change.path}
      {...resourceDragProps(() => [change.uri.toString()])}
    >
      <FileIcon resource={change.uri} isDirectory={false} className={styles['icon']} />
      <span className={styles['name']}>{basenameOfResource(change.uri)}</span>
      {inferred && (
        <span
          className={styles['inferredBadge']}
          data-testid="acp-changes-inferred"
          data-tooltip={localize(
            'acp.changes.inferredTip',
            'Detected on disk during the turn but not reported by the agent — the change may not be its doing.',
          )}
        >
          {localize('acp.changes.inferred', 'inferred')}
        </span>
      )}
      {showDir && <span className={styles['dir']}>{dirnameOfResource(change.uri)}</span>}
      <span className={styles['actions']}>
        {inferred && (
          <button
            type="button"
            className={styles['actionButton']}
            data-tooltip={localize('acp.changes.dismissInferred', 'Not the agent — ignore')}
            aria-label={localize('acp.changes.dismissInferred', 'Not the agent — ignore')}
            data-testid="acp-changes-dismiss"
            onClick={(e) => {
              e.stopPropagation()
              onDismiss(change)
            }}
          >
            <EyeOff size={16} strokeWidth={1.6} />
          </button>
        )}
        <ResourcePreviewButton resource={change.uri} testId="acp-changes-open-preview" />
        <button
          type="button"
          className={styles['actionButton']}
          data-tooltip={localize('acp.changes.openFile', 'Open File')}
          aria-label={localize('acp.changes.openFile', 'Open File')}
          data-testid="acp-changes-open-file"
          onClick={(e) => {
            e.stopPropagation()
            onOpenFile(change)
          }}
        >
          <FileSymlink size={16} strokeWidth={1.6} />
        </button>
      </span>
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
