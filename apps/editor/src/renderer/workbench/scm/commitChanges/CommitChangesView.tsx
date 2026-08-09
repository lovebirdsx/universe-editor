/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CommitChangesView — sidebar view (inside the SCM container) showing one
 *  commit's changed files, fed by the `_workbench.showCommitChanges` bridge
 *  command through commitChangesViewState. The tree mechanics (keyboard nav,
 *  collapse state, focus landing/memory) live in the shared ChangesTree;
 *  this wrapper contributes the header, the rename-aware row presentation and
 *  the openExternalCommand bridge. Clicking a file row executes the payload's
 *  openExternalCommand (e.g. git-graph.openFileDiff) to open the single-file
 *  diff; an inline "Open File" button opens the working-copy file.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ICommandService,
  IEditorResolverService,
  IStorageService,
  localize,
  StorageScope,
  URI,
} from '@universe-editor/platform'
import type {
  CommitChangesFileEntry,
  ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'
import { useObservable, useService } from '../../useService.js'
import { COMMIT_CHANGES_VIEW_ID } from '../../../actions/commitChangesActions.js'
import { ActionButton } from '../scmShared.js'
import {
  ChangesTree,
  type ChangesTreeFileDisplay,
  type ChangesTreeFocusMemory,
} from '../../changesTree/ChangesTree.js'
import type { ChangesTreeItem } from '../../changesTree/buildSnapshot.js'
import sharedStyles from '../../changesTree/ChangesTree.module.css'
import { commitChangesViewState, COMMIT_CHANGES_VIEW_MODE_STORAGE_KEY } from './viewState.js'
import styles from './CommitChangesView.module.css'

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function formatAuthorDate(unixSeconds: number): string {
  if (!unixSeconds) return ''
  return new Date(unixSeconds * 1000).toLocaleString()
}

function statusClass(status: string): string | undefined {
  return sharedStyles[`status${status.charAt(0)}`]
}

function toItem(entry: CommitChangesFileEntry): ChangesTreeItem<CommitChangesFileEntry> {
  const segments = entry.path.split('/').filter((p) => p !== '')
  segments.pop()
  return { path: entry.path, dirSegments: segments, dir: dirname(entry.path), entry }
}

const openFileAction = {
  id: 'commitChanges.openFile',
  title: localize('scm.openFile', 'Open File'),
  command: '',
  icon: 'go-to-file',
}

function CommitChangesContent({ payload }: { payload: ShowCommitChangesPayload }) {
  const commandService = useService(ICommandService)
  const editorResolverService = useService(IEditorResolverService)
  const viewMode = useObservable(commitChangesViewState.viewMode)

  const items = useMemo(() => payload.files.map(toItem), [payload.files])

  const describeFile = useCallback(
    (entry: CommitChangesFileEntry): ChangesTreeFileDisplay => {
      const fileUri = entry.resourceUri !== null ? URI.parse(entry.resourceUri) : null
      // FileIcon only needs the name/extension for language + icon resolution,
      // so a deleted file (resourceUri null) still gets its glyph from the path.
      const iconUri = fileUri ?? URI.file(entry.path)
      const letter = entry.status.charAt(0)
      return {
        iconUri,
        label: basename(entry.path),
        tooltip: entry.oldPath !== null ? `${entry.oldPath} → ${entry.path}` : entry.path,
        labelPrefix:
          entry.oldPath !== null ? (
            <>
              <span className={sharedStyles['renameFrom']}>{basename(entry.oldPath)}</span>
              <span className={sharedStyles['renameArrow']}>→</span>
            </>
          ) : null,
        actions:
          fileUri !== null ? (
            <ActionButton
              action={openFileAction}
              onRun={(e) => {
                e.stopPropagation()
                void editorResolverService.openEditor(fileUri, { pinned: true })
              }}
            />
          ) : null,
        statusBadge: (
          <span
            className={`${sharedStyles['statusLetter'] ?? ''} ${statusClass(entry.status) ?? ''}`}
            data-status={letter}
          >
            {letter}
          </span>
        ),
      }
    },
    [editorResolverService],
  )

  const openDiff = useCallback(
    (entry: CommitChangesFileEntry): void => {
      void commandService.executeCommand(payload.openExternalCommand, entry.args)
    },
    [commandService, payload.openExternalCommand],
  )
  const onActivateFile = useCallback(
    (entry: CommitChangesFileEntry, opts: { readonly preview: boolean }): void => {
      if (opts.preview) {
        void commandService.executeCommand(payload.openExternalCommand, entry.args, {
          preserveFocus: true,
        })
      } else {
        void commandService.executeCommand(payload.openExternalCommand, entry.args)
      }
    },
    [commandService, payload.openExternalCommand],
  )

  // Remember the focused file per commit so a remount (every show() bumps the
  // tick, resetting the TreeModel) can restore it when the view regains focus.
  const focusMemory = useMemo<ChangesTreeFocusMemory>(
    () => ({
      remember: (path) => commitChangesViewState.rememberFocusedFile(payload.commitRef, path),
      recall: () => commitChangesViewState.focusedFileFor(payload.commitRef),
    }),
    [payload.commitRef],
  )

  const metadata = payload.metadata
  const metaLine = [
    ...(metadata?.author !== undefined ? [metadata.author] : []),
    ...(metadata?.authorDate !== undefined ? [formatAuthorDate(metadata.authorDate)] : []),
  ].join(' · ')

  const header = (
    <div className={styles['header']}>
      <div
        className={styles['title']}
        data-tooltip={metadata?.message ?? payload.title}
        data-testid="commitChanges-title"
      >
        {payload.title}
      </div>
      {metaLine !== '' && (
        <div className={styles['meta']} data-testid="commitChanges-meta">
          {metaLine}
        </div>
      )}
    </div>
  )

  return (
    <ChangesTree<CommitChangesFileEntry>
      items={items}
      viewMode={viewMode}
      viewId={COMMIT_CHANGES_VIEW_ID}
      ariaLabel={localize('commitChanges.treeLabel', 'Changed files')}
      collapseAllSignal={commitChangesViewState.collapseAllSignal}
      expandAllSignal={commitChangesViewState.expandAllSignal}
      describeFile={describeFile}
      onActivateFile={onActivateFile}
      onFileClick={openDiff}
      onFileDoubleClick={openDiff}
      revealPath={payload.revealPath}
      focusMemory={focusMemory}
      header={header}
    />
  )
}

export function CommitChangesView() {
  const storage = useService(IStorageService)
  const payload = useObservable(commitChangesViewState.payload)
  const tick = useObservable(commitChangesViewState.tick)

  // CommitChangesView owns the IStorageService dependency, so it loads the
  // persisted view mode into the shared store on mount and writes it back on
  // change — same pattern as ScmView's 'scm.viewMode'. The title toolbar flips
  // the mode through `commitChangesViewState`; the body just reads it.
  const restoredRef = useRef(false)
  useEffect(() => {
    let active = true
    void storage
      .get<string>(COMMIT_CHANGES_VIEW_MODE_STORAGE_KEY, StorageScope.GLOBAL)
      .then((stored) => {
        if (active && (stored === 'list' || stored === 'tree')) {
          commitChangesViewState.setViewMode(stored)
        }
        if (active) restoredRef.current = true
      })
    return () => {
      active = false
    }
  }, [storage])

  const viewMode = useObservable(commitChangesViewState.viewMode)
  useEffect(() => {
    if (!restoredRef.current) return
    void storage.set(COMMIT_CHANGES_VIEW_MODE_STORAGE_KEY, viewMode, StorageScope.GLOBAL)
  }, [viewMode, storage])

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
