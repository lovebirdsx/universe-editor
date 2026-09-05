/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmChangesView — sidebar view (inside the Swarm container) showing the
 *  changed files of the review currently focused in the Swarm Reviews tree, fed
 *  through swarmChangesViewState. It always shows the review's LATEST version
 *  (the last entry's immutable archive shelf) versus the depot base — the review
 *  detail tab owns the version / compare selectors. The tree mechanics (keyboard
 *  nav, collapse state, focus landing/memory, scroll restore) live in the shared
 *  ChangesTree; this wrapper contributes the Swarm data feed and the row
 *  presentation. Activating a row opens the same diff tab the detail editor
 *  opens (shared openSwarmFileDiff).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ICommandService,
  IEditorService,
  IInstantiationService,
  ILoggerService,
  INotificationService,
  IStorageService,
  StorageScope,
  URI,
  localize,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmDescribeVersionRequest,
  type SwarmGetReviewRequest,
  type SwarmReviewDetailDto,
  type SwarmReviewFileDto,
} from '@universe-editor/extensions-common'
import { useObservable, useService } from '../useService.js'
import { SWARM_CHANGES_VIEW_ID } from '../../actions/swarmActions.js'
import { openSwarmFileDiff } from '../../services/swarm/openSwarmFileDiff.js'
import { waitForSwarmCommand } from '../../services/swarm/swarmCommandReady.js'
import { swarmReviewDetailCache, swarmReviewEvents } from '../../services/swarm/swarmViewState.js'
import {
  ChangesTree,
  type ChangesTreeFileDisplay,
  type ChangesTreeFocusMemory,
} from '../changesTree/ChangesTree.js'
import type { ChangesTreeItem } from '../changesTree/buildSnapshot.js'
import sharedStyles from '../changesTree/ChangesTree.module.css'
import {
  swarmChangesViewState,
  SWARM_CHANGES_VIEW_MODE_STORAGE_KEY,
} from './swarmChangesViewState.js'
import styles from './SwarmChangesView.module.css'

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function toItem(file: SwarmReviewFileDto): ChangesTreeItem<SwarmReviewFileDto> {
  const segments = file.path.split('/').filter((p) => p !== '')
  segments.pop()
  return { path: file.path, dirSegments: segments, dir: dirname(file.path), entry: file }
}

/** A `swarm:` URI over the display path — FileIcon only needs the name for
 *  language + icon resolution, and the depot file has no workspace URI. */
function fileResource(file: SwarmReviewFileDto): URI {
  return URI.from({ scheme: 'swarm', path: `/${file.path}` })
}

/** The latest version's backing snapshot: the immutable archive shelf when the
 *  version has one, else the (re-shelvable) pending changelist. Never the rev —
 *  pending re-shelves all report the same rev. */
function latestSnapshot(
  detail: SwarmReviewDetailDto | null,
): { change: string; rev: number; immutable: boolean } | null {
  const last = detail?.versions[detail.versions.length - 1]
  if (!last) return null
  const change = last.archiveChange ?? last.change
  if (!change) return null
  return { change, rev: last.version, immutable: last.archiveChange !== undefined }
}

interface ChangesState {
  readonly files: readonly SwarmReviewFileDto[] | null
  readonly snapshot: { change: string; rev: number; immutable: boolean } | null
  readonly error: string | null
}

const EMPTY_STATE: ChangesState = { files: null, snapshot: null, error: null }

function SwarmChangesContent({ reviewId }: { reviewId: string }) {
  const commands = useService(ICommandService)
  const editorService = useService(IEditorService)
  const inst = useService(IInstantiationService)
  const loggerService = useService(ILoggerService)
  const logger = useMemo(
    () => loggerService.createLogger({ id: 'swarmChanges', name: 'Swarm Changes' }),
    [loggerService],
  )
  const notifications = useService(INotificationService)
  const viewMode = useObservable(swarmChangesViewState.viewMode)

  const [state, setState] = useState<ChangesState>(EMPTY_STATE)
  // Bumped by the review-mutation bus so a re-shelve re-fetches even when the
  // selected review id did not change.
  const [refreshGeneration, setRefreshGeneration] = useState(0)

  useEffect(() => {
    const d = swarmReviewEvents.onDidMutateReview((id) => {
      if (id === reviewId) setRefreshGeneration((g) => g + 1)
    })
    return () => d.dispose()
  }, [reviewId])

  useEffect(() => {
    const controller = new AbortController()
    const force = refreshGeneration > 0
    // Paint the cached detail (populated by the review tab) immediately, then
    // confirm it against the server — the file list still waits for the fetch,
    // but the snapshot resolution is instant on a review already opened once.
    void (async () => {
      let detail = force ? null : (swarmReviewDetailCache.get(reviewId) ?? null)
      if (!detail) {
        const ready = await waitForSwarmCommand(SwarmCommands.getReview, controller.signal)
        if (!ready || controller.signal.aborted) return
        detail =
          (await commands.executeCommand<SwarmReviewDetailDto | undefined>(
            SwarmCommands.getReview,
            { reviewId, ...(force ? { force: true } : {}) } satisfies SwarmGetReviewRequest,
          )) ?? null
        if (controller.signal.aborted) return
        if (detail) swarmReviewDetailCache.set(reviewId, detail)
      }
      const snapshot = latestSnapshot(detail)
      if (!snapshot) {
        setState({ files: [], snapshot: null, error: null })
        return
      }
      const ready = await waitForSwarmCommand(SwarmCommands.describeVersion, controller.signal)
      if (!ready || controller.signal.aborted) return
      const files = await commands.executeCommand<SwarmReviewFileDto[]>(
        SwarmCommands.describeVersion,
        {
          change: snapshot.change,
          // An immutable archive shelf can never change, so a forced refresh
          // must not pay for a re-fetch of it.
          ...(force && !snapshot.immutable ? { force: true } : {}),
          ...(snapshot.immutable ? { immutable: true } : {}),
        } satisfies SwarmDescribeVersionRequest,
      )
      if (controller.signal.aborted) return
      setState({ files: files ?? [], snapshot, error: null })
    })().catch((e: unknown) => {
      if (controller.signal.aborted) return
      setState({
        files: [],
        snapshot: null,
        error: e instanceof Error ? e.message : String(e),
      })
    })
    return () => controller.abort()
  }, [commands, reviewId, refreshGeneration])

  const files = state.files
  const items = useMemo(() => (files ?? []).map(toItem), [files])

  const describeFile = useCallback((file: SwarmReviewFileDto): ChangesTreeFileDisplay => {
    const letter = file.status.charAt(0)
    return {
      iconUri: fileResource(file),
      label: basename(file.path),
      tooltip: file.path,
      rowTestId: 'swarm-changes-row',
      rowDataStatus: letter,
      statusBadge: (
        <span
          className={`${sharedStyles['statusLetter'] ?? ''} ${sharedStyles[`status${letter}`] ?? ''}`}
          data-status={letter}
        >
          {file.status}
        </span>
      ),
    }
  }, [])

  const snapshot = state.snapshot
  const openDiff = useCallback(
    (file: SwarmReviewFileDto, preview: boolean): void => {
      if (!snapshot) return
      void openSwarmFileDiff(
        {
          reviewId,
          file,
          rightChange: snapshot.change,
          rightRev: snapshot.rev,
          // The sidebar always compares the latest version against the depot
          // base, matching how the file list itself is computed.
          leftChange: null,
          leftVersion: 0,
          rightImmutable: snapshot.immutable,
          leftImmutable: false,
          preview,
        },
        {
          commands,
          editorService,
          inst,
          logger,
          notifications,
          onError: (message) => setState((prev) => ({ ...prev, error: message })),
        },
      )
    },
    [commands, editorService, inst, logger, notifications, reviewId, snapshot],
  )

  const onActivateFile = useCallback(
    (file: SwarmReviewFileDto, opts: { readonly preview: boolean }): void =>
      openDiff(file, opts.preview),
    [openDiff],
  )
  const onFileClick = useCallback(
    (file: SwarmReviewFileDto): void => openDiff(file, true),
    [openDiff],
  )
  const onFileDoubleClick = useCallback(
    (file: SwarmReviewFileDto): void => openDiff(file, false),
    [openDiff],
  )

  const focusMemory = useMemo<ChangesTreeFocusMemory>(
    () => ({
      remember: (path) => swarmChangesViewState.rememberFocusedFile(reviewId, path),
      recall: () => swarmChangesViewState.focusedFileFor(reviewId),
    }),
    [reviewId],
  )

  if (state.error !== null) {
    return <div className={styles['error']}>{state.error}</div>
  }
  if (files === null) {
    return <div className={styles['empty']}>{localize('swarm.loading', 'Loading…')}</div>
  }
  if (files.length === 0) {
    return (
      <div className={styles['empty']} data-testid="swarm-changes-empty">
        {localize('swarmChanges.noFiles', 'This review has no changed files.')}
      </div>
    )
  }

  const header = (
    <div className={styles['header']}>
      <span className={styles['title']}>
        {localize('swarmChanges.reviewTitle', 'Review #{0}', { 0: reviewId })}
      </span>
      {snapshot !== null && (
        <span className={styles['meta']}>
          {localize('swarmChanges.version', 'v{0}', { 0: String(snapshot.rev) })}
        </span>
      )}
    </div>
  )

  return (
    <ChangesTree<SwarmReviewFileDto>
      items={items}
      viewMode={viewMode}
      viewId={SWARM_CHANGES_VIEW_ID}
      ariaLabel={localize('swarmChanges.treeLabel', 'Changed files')}
      collapseAllSignal={swarmChangesViewState.collapseAllSignal}
      expandAllSignal={swarmChangesViewState.expandAllSignal}
      describeFile={describeFile}
      onActivateFile={onActivateFile}
      onFileClick={onFileClick}
      onFileDoubleClick={onFileDoubleClick}
      focusMemory={focusMemory}
      scrollStateKey="swarmChanges"
      folderTestId="swarm-changes-folder"
      header={header}
    />
  )
}

export function SwarmChangesView() {
  const storage = useService(IStorageService)
  const reviewId = useObservable(swarmChangesViewState.selectedReviewId)
  const tick = useObservable(swarmChangesViewState.tick)

  // This view owns the IStorageService dependency, so it restores the persisted
  // view mode into the shared store on mount and writes it back on change. The
  // title toolbar flips the mode through `swarmChangesViewState`.
  const restoredRef = useRef(false)
  useEffect(() => {
    let active = true
    void storage
      .get<string>(SWARM_CHANGES_VIEW_MODE_STORAGE_KEY, StorageScope.GLOBAL)
      .then((stored) => {
        if (active && (stored === 'list' || stored === 'tree')) {
          swarmChangesViewState.setViewMode(stored)
        }
        if (active) restoredRef.current = true
      })
    return () => {
      active = false
    }
  }, [storage])

  const viewMode = useObservable(swarmChangesViewState.viewMode)
  useEffect(() => {
    if (!restoredRef.current) return
    void storage.set(SWARM_CHANGES_VIEW_MODE_STORAGE_KEY, viewMode, StorageScope.GLOBAL)
  }, [viewMode, storage])

  return (
    <div className={styles['view']} tabIndex={-1} data-testid="swarm-changes-view">
      {reviewId === null ? (
        <div className={styles['empty']} data-testid="swarm-changes-empty">
          {localize('swarmChanges.empty', 'Select a review to see its changed files.')}
        </div>
      ) : (
        // Remount per select(): resets the collapsed set and the TreeModel so a
        // new review never inherits the previous one's folding.
        <SwarmChangesContent key={tick} reviewId={reviewId} />
      )}
    </div>
  )
}
