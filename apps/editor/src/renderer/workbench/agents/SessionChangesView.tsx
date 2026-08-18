/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionChangesView — the "Session Changes" viewlet. Lists the whole-file
 *  modifications the active agent session made (tracked via ISessionChange
 *  TrackerService), SCM-CHANGES style: a list or tree of changed files. Single-
 *  click previews a whole-file diff (reuses the preview tab); double-click pins
 *  it. The baseline is the pinned pre-edit snapshot captured at first touch
 *  (agent-reported, or git HEAD for watched entries), diffed vs. the current
 *  on-disk content. The tree mechanics (keyboard nav, collapse state, focus
 *  landing/memory, scroll restore) live in the shared ChangesTree; this wrapper
 *  contributes the session data feed and the row presentation (inferred badge,
 *  hover actions, status letter).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { EyeOff, FileSymlink } from 'lucide-react'
import {
  IEditorResolverService,
  IInstantiationService,
  IStorageService,
  IUriIdentityService,
  IWorkspaceService,
  StorageScope,
  localize,
  observableValue,
  type IObservable,
} from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import {
  ISessionChangeTrackerService,
  type SessionFileChange,
} from '../../services/acp/session/sessionChangeTracker.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { ResourcePreviewButton } from '../files/ResourcePreviewButton.js'
import { basenameOfResource, dirnameOfResource } from '../files/resourceInfo.js'
import {
  ChangesTree,
  type ChangesTreeFileDisplay,
  type ChangesTreeFocusMemory,
} from '../changesTree/ChangesTree.js'
import { useOpenDiffEditor } from '../changesTree/useOpenDiffEditor.js'
import type { ChangesTreeItem } from '../changesTree/buildSnapshot.js'
import sharedStyles from '../changesTree/ChangesTree.module.css'
import { SESSION_CHANGES_VIEW_ID } from '../../actions/agentTimelineActions.js'
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
  const workspace = useService(IWorkspaceService)
  const uriIdentity = useService(IUriIdentityService)
  const session = useObservable(sessions.activeSession)
  // change tracker 以 agent 颁发的 sessionIdOnAgent 为 key 记录改动；连接完成前它是
  // undefined，此时无改动可显示。observe 它以便连接就绪后自动刷新。
  const sessionIdOnAgent = useObservable(session?.sessionIdOnAgent ?? EMPTY_ID_OBS)
  const changes = useObservable(sessionIdOnAgent ? tracker.changesFor(sessionIdOnAgent) : EMPTY_OBS)
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

  const open = useOpenChange()
  const openFile = useOpenFile()
  const dismiss = useDismissWatched()

  // `uri.path`（不是 `.fsPath`）与 dirnameOfResource 保持一致，随远端工作区正确。
  const rootDir = workspace.current?.folder.path ?? ''
  const items = useMemo<readonly ChangesTreeItem<SessionFileChange>[]>(
    () =>
      changes.map((c) => {
        const dir = dirnameOfResource(c.uri)
        // Platform-aware relativization: an agent-reported path whose drive-letter
        // casing differs from the workspace folder still groups under the root.
        const rel = rootDir.length > 0 ? uriIdentity.relativePathUnder(rootDir, dir) : null
        const effective = rel ?? dir
        return {
          path: c.path,
          dirSegments:
            effective.length === 0 ? [] : effective.split('/').filter((s) => s.length > 0),
          dir: dirnameOfResource(c.uri),
          entry: c,
        }
      }),
    [changes, rootDir, uriIdentity],
  )

  const describeFile = useCallback(
    (c: SessionFileChange): ChangesTreeFileDisplay => {
      const inferred = c.origin === 'watched'
      return {
        iconUri: c.uri,
        label: basenameOfResource(c.uri),
        tooltip: c.path,
        rowTestId: 'acp-changes-row',
        rowDataStatus: c.status,
        dragUris: [c.uri.toString()],
        labelSuffix: inferred ? (
          <span
            className={sharedStyles['inferredBadge']}
            data-testid="acp-changes-inferred"
            data-tooltip={localize(
              'acp.changes.inferredTip',
              'Detected on disk during the turn but not reported by the agent — the change may not be its doing.',
            )}
          >
            {localize('acp.changes.inferred', 'inferred')}
          </span>
        ) : null,
        actions: (
          <>
            {inferred && (
              <button
                type="button"
                className={sharedStyles['actionButton']}
                data-tooltip={localize('acp.changes.dismissInferred', 'Not the agent — ignore')}
                aria-label={localize('acp.changes.dismissInferred', 'Not the agent — ignore')}
                data-testid="acp-changes-dismiss"
                onClick={(e) => {
                  e.stopPropagation()
                  dismiss(c)
                }}
              >
                <EyeOff size={16} strokeWidth={1.6} />
              </button>
            )}
            <ResourcePreviewButton resource={c.uri} testId="acp-changes-open-preview" />
            <button
              type="button"
              className={sharedStyles['actionButton']}
              data-tooltip={localize('acp.changes.openFile', 'Open File')}
              aria-label={localize('acp.changes.openFile', 'Open File')}
              data-testid="acp-changes-open-file"
              onClick={(e) => {
                e.stopPropagation()
                openFile(c)
              }}
            >
              <FileSymlink size={16} strokeWidth={1.6} />
            </button>
          </>
        ),
        statusBadge: (
          <span className={sharedStyles['badge']} data-status={c.status} aria-hidden="true">
            {statusLetter(c.status)}
          </span>
        ),
      }
    },
    [dismiss, openFile],
  )

  const onActivateFile = useCallback(
    (c: SessionFileChange, opts: { readonly preview: boolean }): void => open(c, opts.preview),
    [open],
  )
  const onFileClick = useCallback((c: SessionFileChange): void => open(c, true), [open])
  const onFileDoubleClick = useCallback((c: SessionFileChange): void => open(c, false), [open])

  // Remember the focused file per session so a remount (fresh TreeModel) can
  // restore it when the view regains focus.
  const focusMemory = useMemo<ChangesTreeFocusMemory | undefined>(
    () =>
      typeof sessionIdOnAgent === 'string'
        ? {
            remember: (path) => sessionChangesViewState.rememberFocusedFile(sessionIdOnAgent, path),
            recall: () => sessionChangesViewState.focusedFileFor(sessionIdOnAgent),
          }
        : undefined,
    [sessionIdOnAgent],
  )

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
      <ChangesTree<SessionFileChange>
        items={items}
        viewMode={viewMode}
        viewId={SESSION_CHANGES_VIEW_ID}
        ariaLabel={localize('acp.changes.treeLabel', 'Changed files')}
        collapseAllSignal={sessionChangesViewState.collapseAllSignal}
        expandAllSignal={sessionChangesViewState.expandAllSignal}
        describeFile={describeFile}
        onActivateFile={onActivateFile}
        onFileClick={onFileClick}
        onFileDoubleClick={onFileDoubleClick}
        focusMemory={focusMemory}
        scrollStateKey="sessionChanges"
        folderTestId="acp-changes-folder"
      />
    </div>
  )
}

function useOpenChange(): (c: SessionFileChange, preview: boolean) => void {
  const inst = useService(IInstantiationService)
  const createInput = useCallback(
    (c: SessionFileChange) =>
      inst.createInstance(DiffEditorInput, c.uri, c.baseline, c.current, undefined, c.uri, true),
    [inst],
  )
  return useOpenDiffEditor(createInput)
}

function useOpenFile(): (c: SessionFileChange) => void {
  const resolver = useService(IEditorResolverService)
  return useCallback(
    (c: SessionFileChange) => {
      void resolver.openEditor(c.uri, { pinned: true })
    },
    [resolver],
  )
}

/** Dismiss a watched (inferred) entry — the user judged it their own change. */
function useDismissWatched(): (c: SessionFileChange) => void {
  const sessions = useService(IAcpSessionService)
  const tracker = useService(ISessionChangeTrackerService)
  return useCallback(
    (c: SessionFileChange) => {
      const sid = sessions.activeSession.get()?.sessionIdOnAgent.get()
      if (sid !== undefined) tracker.dismissWatched(sid, c.path)
    },
    [sessions, tracker],
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
