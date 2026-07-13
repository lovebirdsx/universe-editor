/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmReviewEditor — main-area tab showing one Swarm review: header (state
 *  badge, author, participants + votes), description, a version selector, and the
 *  changed-file list for the selected version. Clicking a file opens its diff
 *  (P3). Review-level + inline comments arrive in P3/P4. All wire logic is behind
 *  ICommandService. State is cached in swarmReviewDetailCache for instant reopen.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ICommandService,
  IDialogService,
  IEditorService,
  IStorageService,
  StorageScope,
  type IEditorInput,
  localize,
} from '@universe-editor/platform'
import { Button, Spinner, cx } from '@universe-editor/workbench-ui'
import {
  SwarmCommands,
  type SwarmAddCommentRequest,
  type SwarmCommentDto,
  type SwarmReviewDetailDto,
  type SwarmReviewFileDto,
  type SwarmTransitionRequest,
  type SwarmUpdateReviewRequest,
  type SwarmVoteRequest,
} from '@universe-editor/extensions-common'
import { useObservable, useService } from '../useService.js'
import { SwarmReviewEditorInput } from '../../services/editor/SwarmReviewEditorInput.js'
import { SwarmDiffEditorInput } from '../../services/editor/SwarmDiffEditorInput.js'
import { waitForSwarmCommand } from '../../services/swarm/swarmCommandReady.js'
import {
  swarmReviewDetailCache,
  swarmReviewFilesViewState,
  type SwarmReviewFilesViewMode,
} from '../../services/swarm/swarmViewState.js'
import { SwarmReviewFiles } from './SwarmReviewFiles.js'
import styles from './SwarmReviewEditor.module.css'

const FILES_VIEW_MODE_STORAGE_KEY = 'swarm.reviewFiles.viewMode'

const STATE_CLASS: Record<string, string | undefined> = {
  needsReview: styles['stateNeedsReview'],
  needsRevision: styles['stateNeedsRevision'],
  approved: styles['stateApproved'],
  rejected: styles['stateRejected'],
  archived: styles['stateArchived'],
}

/** Transition state keys that irreversibly commit the shelved change. */
function isCommitTransition(state: string): boolean {
  return state.includes('commit')
}

export function SwarmReviewEditor({ input }: { input: IEditorInput }) {
  const commands = useService(ICommandService)
  const dialog = useService(IDialogService)
  const editorService = useService(IEditorService)
  const storage = useService(IStorageService)
  const reviewId = input instanceof SwarmReviewEditorInput ? input.reviewId : ''
  const filesViewMode = useObservable(swarmReviewFilesViewState.viewMode)

  const [detail, setDetail] = useState<SwarmReviewDetailDto | null>(
    swarmReviewDetailCache.get(reviewId) ?? null,
  )
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<SwarmReviewFileDto[] | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  /** The base version to compare against (left side); null = the version before it. */
  const [compareVersion, setCompareVersion] = useState<number | null>(null)
  const [comments, setComments] = useState<SwarmCommentDto[] | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const loadAbortRef = useRef<AbortController | null>(null)
  const filesViewModeRestoredRef = useRef(false)

  const load = useCallback(() => {
    if (!reviewId) return
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    setLoading(true)
    setError(null)
    void (async () => {
      const ready = await waitForSwarmCommand(SwarmCommands.getReview, controller.signal)
      if (controller.signal.aborted) return
      if (!ready) {
        setError(
          localize(
            'swarm.commands.unavailable',
            'Swarm is unavailable. Check the Perforce extension and connection.',
          ),
        )
        return
      }
      const r = await commands.executeCommand<SwarmReviewDetailDto | undefined>(
        SwarmCommands.getReview,
        reviewId,
      )
      if (controller.signal.aborted) return
      if (!r) {
        setError(
          localize('swarm.review.unavailable', 'Review #{0} is unavailable.', { 0: reviewId }),
        )
        return
      }
      setDetail(r)
      swarmReviewDetailCache.set(reviewId, r)
      // Default to the latest version.
      const latest = r.versions[r.versions.length - 1]?.version ?? null
      setSelectedVersion(latest)
    })()
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
  }, [commands, reviewId])

  const vote = useCallback(
    (value: 'up' | 'down' | 'clear') => {
      if (!reviewId || busy) return
      setBusy(true)
      const req: SwarmVoteRequest = { reviewId, vote: value }
      if (selectedVersion !== null) req.version = selectedVersion
      void commands
        .executeCommand(SwarmCommands.vote, req)
        .then(() => load())
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false))
    },
    [commands, reviewId, selectedVersion, busy, load],
  )

  const transition = useCallback(
    async (state: string, label: string) => {
      if (!reviewId || busy) return
      const commit = isCommitTransition(state)
      if (commit) {
        const res = await dialog.confirm({
          type: 'warning',
          message: localize('swarm.commit.confirm', 'Approve and commit review #{0}?', {
            0: reviewId,
          }),
          detail: localize(
            'swarm.commit.detail',
            'This submits the shelved change to the depot. This action cannot be undone.',
          ),
          primaryButton: label,
        })
        if (!res.confirmed) return
      }
      setBusy(true)
      const req: SwarmTransitionRequest = { reviewId, state }
      if (commit) req.commit = true
      void commands
        .executeCommand(SwarmCommands.transition, req)
        .then(() => load())
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false))
    },
    [commands, dialog, reviewId, busy, load],
  )

  const updateReview = useCallback(() => {
    if (!reviewId || busy) return
    setBusy(true)
    const req: SwarmUpdateReviewRequest = { reviewId }
    void commands
      .executeCommand(SwarmCommands.updateReview, req)
      .then((ok) => {
        if (ok) load()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [commands, reviewId, busy, load])

  // The change backing a given version (for the diff sides).
  const changeForVersion = useCallback(
    (version: number | null): string | null =>
      version === null
        ? null
        : (detail?.versions.find((v) => v.version === version)?.change ?? null),
    [detail],
  )

  // Open a file's diff between the compare (left) and selected (right) versions.
  // Both sides are p4 snapshots at their version's backing change, so line numbers
  // stay aligned with Swarm's inline-comment coordinates.
  const openFileDiff = useCallback(
    async (file: SwarmReviewFileDto) => {
      if (!detail) return
      const rightChange = changeForVersion(selectedVersion)
      // Left = the explicit compare version, or the one just before the selected.
      const idx = detail.versions.findIndex((v) => v.version === selectedVersion)
      const prev = idx > 0 ? (detail.versions[idx - 1]?.version ?? null) : null
      const leftVersion = compareVersion ?? prev
      const leftChange = changeForVersion(leftVersion)
      const added = file.status.charAt(0) === 'A'
      const deleted = file.status.charAt(0) === 'D'
      try {
        const [original, modified] = await Promise.all([
          added || !leftChange
            ? Promise.resolve('')
            : commands.executeCommand<string>(SwarmCommands.getFileContent, {
                depotFile: file.depotFile,
                change: leftChange,
              }),
          deleted || !rightChange
            ? Promise.resolve('')
            : commands.executeCommand<string>(SwarmCommands.getFileContent, {
                depotFile: file.depotFile,
                change: rightChange,
              }),
        ])
        await editorService.openEditor(
          new SwarmDiffEditorInput(
            {
              reviewId: detail.id,
              depotFile: file.depotFile,
              displayPath: file.path,
              leftVersion: added ? null : leftVersion,
              rightVersion: deleted ? null : selectedVersion,
            },
            original ?? '',
            modified ?? '',
          ),
        )
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [commands, editorService, detail, selectedVersion, compareVersion, changeForVersion],
  )

  const loadComments = useCallback(
    (signal?: AbortSignal) => {
      if (!reviewId) return
      void (async () => {
        const ready = await waitForSwarmCommand(SwarmCommands.listComments, signal)
        if (!ready || signal?.aborted) {
          if (!signal?.aborted) setComments([])
          return
        }
        const result = await commands.executeCommand<SwarmCommentDto[]>(
          SwarmCommands.listComments,
          {
            reviewId,
          },
        )
        if (!signal?.aborted) setComments(result ?? [])
      })().catch(() => {
        if (!signal?.aborted) setComments([])
      })
    },
    [commands, reviewId],
  )

  const addComment = useCallback(() => {
    const body = commentDraft.trim()
    if (!reviewId || !body || busy) return
    setBusy(true)
    const req: SwarmAddCommentRequest = { reviewId, body }
    void commands
      .executeCommand(SwarmCommands.addComment, req)
      .then(() => {
        setCommentDraft('')
        loadComments()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [commands, reviewId, commentDraft, busy, loadComments])

  useEffect(() => {
    if (detail) {
      const latest = detail.versions[detail.versions.length - 1]?.version ?? null
      setSelectedVersion((v) => v ?? latest)
    } else {
      load()
    }
  }, [detail, load])

  useEffect(() => {
    if (!detail) return
    const controller = new AbortController()
    loadComments(controller.signal)
    return () => controller.abort()
  }, [detail, loadComments])

  useEffect(() => () => loadAbortRef.current?.abort(), [])

  useEffect(() => {
    let active = true
    void storage
      .get<SwarmReviewFilesViewMode>(FILES_VIEW_MODE_STORAGE_KEY, StorageScope.GLOBAL)
      .then((stored) => {
        if (!active) return
        if (stored === 'list' || stored === 'tree') swarmReviewFilesViewState.setViewMode(stored)
        filesViewModeRestoredRef.current = true
      })
    return () => {
      active = false
    }
  }, [storage])

  useEffect(() => {
    if (!filesViewModeRestoredRef.current) return
    void storage.set(FILES_VIEW_MODE_STORAGE_KEY, filesViewMode, StorageScope.GLOBAL)
  }, [filesViewMode, storage])

  // Load the selected version's files.
  const selectedChange = useMemo(
    () => detail?.versions.find((v) => v.version === selectedVersion)?.change ?? null,
    [detail, selectedVersion],
  )
  useEffect(() => {
    if (!selectedChange) {
      setFiles(null)
      return
    }
    const controller = new AbortController()
    void (async () => {
      const ready = await waitForSwarmCommand(SwarmCommands.describeVersion, controller.signal)
      if (!ready || controller.signal.aborted) {
        if (!controller.signal.aborted) setFiles([])
        return
      }
      const result = await commands.executeCommand<SwarmReviewFileDto[]>(
        SwarmCommands.describeVersion,
        selectedChange,
      )
      if (!controller.signal.aborted) setFiles(result ?? [])
    })().catch(() => {
      if (!controller.signal.aborted) setFiles([])
    })
    return () => controller.abort()
  }, [commands, selectedChange])

  if (error) {
    return (
      <div className={styles['container']} data-testid="swarm-review-editor">
        <div className={styles['error']}>{error}</div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className={styles['container']} data-testid="swarm-review-editor">
        <div className={styles['message']}>
          {loading ? <Spinner /> : localize('swarm.loading', 'Loading…')}
        </div>
      </div>
    )
  }

  return (
    <div className={styles['container']} data-testid="swarm-review-editor">
      <div className={styles['header']}>
        <div className={styles['titleRow']}>
          <span className={styles['title']}>Review #{detail.id}</span>
          <span className={cx(styles['badge'], STATE_CLASS[detail.state])}>
            {detail.stateLabel}
          </span>
          <span className={styles['author']}>{detail.author}</span>
          <span className={styles['spacer']} />
          {(loading || busy) && <Spinner />}
        </div>
        <div className={styles['actions']}>
          <Button size="sm" variant="ghost" busy={busy} onClick={() => vote('up')}>
            <span className={styles['voteUp']}>↑</span>
            {localize('swarm.vote.up', 'Vote Up')}
          </Button>
          <Button size="sm" variant="ghost" busy={busy} onClick={() => vote('down')}>
            <span className={styles['voteDown']}>↓</span>
            {localize('swarm.vote.down', 'Vote Down')}
          </Button>
          <Button size="sm" variant="ghost" busy={busy} onClick={() => vote('clear')}>
            {localize('swarm.vote.clear', 'Clear Vote')}
          </Button>
          <span className={styles['spacer']} />
          {detail.state === 'needsRevision' && (
            <Button size="sm" variant="secondary" busy={busy} onClick={updateReview}>
              {localize('swarm.updateReview', 'Update Review')}
            </Button>
          )}
          {detail.transitions.map((t) => (
            <Button
              key={t.state}
              size="sm"
              variant={t.state.startsWith('approved') ? 'primary' : 'secondary'}
              busy={busy}
              onClick={() => void transition(t.state, t.label)}
            >
              {t.label}
            </Button>
          ))}
        </div>
        {detail.participants.length > 0 && (
          <div className={styles['participants']}>
            {detail.participants.map((p) => (
              <span
                key={p.user}
                className={cx(styles['participant'], p.required && styles['required'])}
              >
                {p.vote > 0 && <span className={styles['voteUp']}>↑</span>}
                {p.vote < 0 && <span className={styles['voteDown']}>↓</span>}
                {p.user}
                {p.required ? '*' : ''}
              </span>
            ))}
          </div>
        )}
        {detail.description && <div className={styles['description']}>{detail.description}</div>}
      </div>

      {detail.versions.length > 0 && (
        <div className={styles['versionRow']}>
          <span>{localize('swarm.compare', 'Compare')}</span>
          <select
            className={styles['select']}
            value={compareVersion ?? ''}
            onChange={(e) => setCompareVersion(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{localize('swarm.previousVersion', '(previous)')}</option>
            {detail.versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
              </option>
            ))}
          </select>
          <span>⇄</span>
          <select
            className={styles['select']}
            value={selectedVersion ?? ''}
            onChange={(e) => setSelectedVersion(Number(e.target.value))}
          >
            {detail.versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} ({v.change}){v.pending ? '' : ' ✓'}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className={styles['body']}>
        <div className={styles['fileList']}>
          {files === null && (
            <div className={styles['message']}>
              <Spinner />
            </div>
          )}
          {files?.length === 0 && (
            <div className={styles['message']}>
              {localize('swarm.noFiles', 'No files in this version.')}
            </div>
          )}
          {files && files.length > 0 && (
            <SwarmReviewFiles
              files={files}
              viewMode={filesViewMode}
              onViewModeChange={(mode) => swarmReviewFilesViewState.setViewMode(mode)}
              onOpenFile={(file) => void openFileDiff(file)}
            />
          )}
        </div>

        <div className={styles['commentPanel']}>
          <div className={styles['commentHeader']}>
            {localize('swarm.comments', 'Comments')}
            {comments && comments.length > 0 ? ` (${comments.length})` : ''}
          </div>
          <div className={styles['commentList']}>
            {comments === null && <Spinner />}
            {comments?.length === 0 && (
              <div className={styles['message']}>
                {localize('swarm.noComments', 'No comments yet.')}
              </div>
            )}
            {comments
              ?.filter((c) => !c.context?.file)
              .map((c) => (
                <div key={c.id} className={styles['comment']}>
                  <div className={styles['commentMeta']}>
                    <span className={styles['commentAuthor']}>{c.author}</span>
                    {c.taskState !== 'comment' && (
                      <span className={styles['taskBadge']}>{c.taskState}</span>
                    )}
                  </div>
                  <div className={styles['commentBody']}>{c.body}</div>
                </div>
              ))}
          </div>
          <div className={styles['commentCompose']}>
            <textarea
              className={styles['commentInput']}
              value={commentDraft}
              placeholder={localize('swarm.addComment', 'Add a comment…')}
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault()
                  addComment()
                }
              }}
            />
            <Button
              size="sm"
              variant="primary"
              busy={busy}
              disabled={!commentDraft.trim()}
              onClick={addComment}
            >
              {localize('swarm.comment', 'Comment')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
