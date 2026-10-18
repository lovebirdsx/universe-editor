/**
 * Drives the Git Graph "Load all commits" stream: count → optional confirm →
 * start the extension stream → coalesce batches into the commit list. The hook
 * owns the stream id/generation so repo switches, cancels and unmounts cannot
 * let an old stream's batches land in the new view.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  GitGraphCommands,
  type GitGraphCommitBatchDto,
  type GitGraphCommitDto,
  type GitGraphLoadResult,
} from '@universe-editor/extensions-common'
import { localize, type ICommandService, type IDialogService } from '@universe-editor/platform'
import {
  gitGraphViewState,
  type GitGraphLoadMode,
  type GitGraphSettings,
} from '../../services/gitGraph/gitGraphViewState.js'
import {
  LOAD_ALL_CONFIRM_THRESHOLD,
  LOAD_ALL_MAX_COMMITS,
  appendStreamedBatch,
  createStreamedCommitState,
  finishStreamedState,
  materializeStreamedCommits,
  streamFlushInterval,
  type StreamedCommitState,
} from './gitGraphLoadAll.js'

export type GitGraphStreamPhase = 'idle' | 'counting' | 'streaming' | 'cancelled' | 'error'

export interface GitGraphStreamState {
  phase: GitGraphStreamPhase
  /** Real log commits received (excludes synthetic stash nodes). */
  loaded: number
  /** Preflight `rev-list --count`, or null when the count was unavailable. */
  total: number | null
  /** The stream stopped at `LOAD_ALL_MAX_COMMITS`. */
  capped: boolean
  error: string | null
}

const IDLE_STREAM: GitGraphStreamState = {
  phase: 'idle',
  loaded: 0,
  total: null,
  capped: false,
  error: null,
}

export interface UseGitGraphCommitStreamOptions {
  commands: ICommandService
  dialog: IDialogService
  order: GitGraphSettings['order']
  includeRemotes: boolean
  result: GitGraphLoadResult | null
  setResult: Dispatch<SetStateAction<GitGraphLoadResult | null>>
  setSelection: Dispatch<SetStateAction<string[]>>
  setLoadMode: Dispatch<SetStateAction<GitGraphLoadMode>>
  logger?: { debug(message: string): void } | null
}

export interface GitGraphCommitStreamController {
  state: GitGraphStreamState
  loadAll: () => void
  cancel: () => void
  commitBatch: (batch: GitGraphCommitBatchDto) => Promise<boolean>
}

interface BufferedBatch {
  commits: GitGraphCommitDto[]
  logCount: number
  meta?: GitGraphCommitBatchDto['meta']
  done?: boolean
  moreAvailable?: boolean
  error?: string
}

export function useGitGraphCommitStream({
  commands,
  dialog,
  order,
  includeRemotes,
  result,
  setResult,
  setSelection,
  setLoadMode,
  logger,
}: UseGitGraphCommitStreamOptions): GitGraphCommitStreamController {
  const [state, setState] = useState<GitGraphStreamState>(IDLE_STREAM)
  const phaseRef = useRef(state.phase)
  phaseRef.current = state.phase

  const optionsRef = useRef({ order, includeRemotes })
  optionsRef.current = { order, includeRemotes }
  const loggerRef = useRef(logger)
  loggerRef.current = logger

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const streamIdRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const totalRef = useRef<number | null>(null)
  const receivedRef = useRef(0)
  const cappedRef = useRef(false)

  const commitsRef = useRef<readonly GitGraphCommitDto[]>(result?.commits ?? [])
  const metaRef = useRef({
    head: result?.head ?? null,
    headName: result?.headName ?? null,
    uncommittedChanges: result?.uncommittedChanges ?? 0,
  })
  // Re-sync when the component replaces the result outside the stream
  // (initial load, shallow revalidate). During the stream the flush updates
  // these refs first, so this effect writes the same values back.
  useEffect(() => {
    commitsRef.current = result?.commits ?? []
    if (result) {
      metaRef.current = {
        head: result.head,
        headName: result.headName,
        uncommittedChanges: result.uncommittedChanges,
      }
    }
  }, [result])

  const bufferRef = useRef<BufferedBatch>({ commits: [], logCount: 0 })
  const streamStateRef = useRef<StreamedCommitState>(createStreamedCommitState())
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingResolversRef = useRef<Array<(ok: boolean) => void>>([])

  const resolvePending = useCallback((ok: boolean) => {
    const resolvers = pendingResolversRef.current
    pendingResolversRef.current = []
    for (const resolve of resolvers) resolve(ok)
  }, [])

  const flushBuffer = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    if (!mountedRef.current) {
      bufferRef.current = { commits: [], logCount: 0 }
      resolvePending(false)
      return
    }
    const buffered = bufferRef.current
    bufferRef.current = { commits: [], logCount: 0 }

    const hasPayload =
      buffered.commits.length > 0 ||
      buffered.meta !== undefined ||
      buffered.done === true ||
      buffered.error !== undefined
    if (!hasPayload) {
      resolvePending(true)
      return
    }

    if (buffered.meta) {
      // Metadata can fail while git log still streams; the extension then sends
      // an empty fallback. Keep the paged result's HEAD rather than blanking it.
      const meta = buffered.meta
      const empty = meta.head === null && meta.headName === null && meta.uncommittedChanges === 0
      if (!empty || metaRef.current.head === null) metaRef.current = meta
    }
    if (buffered.commits.length > 0) {
      streamStateRef.current = appendStreamedBatch(
        streamStateRef.current,
        commitsRef.current,
        buffered.commits,
      )
    }
    if (buffered.done === true && buffered.error === undefined) {
      // The stream covered everything (or every commit up to the cap), so any
      // pre-stream commit it did not produce is stale (rewritten history).
      streamStateRef.current = finishStreamedState(streamStateRef.current)
    }
    if (buffered.commits.length > 0 || buffered.done === true) {
      commitsRef.current = materializeStreamedCommits(streamStateRef.current)
    }
    receivedRef.current += buffered.logCount
    const total = totalRef.current
    const loaded = total === null ? receivedRef.current : Math.min(receivedRef.current, total)

    const moreAvailable = buffered.done === true ? buffered.moreAvailable === true : true
    setResult({
      commits: [...commitsRef.current],
      head: metaRef.current.head,
      headName: metaRef.current.headName,
      uncommittedChanges: metaRef.current.uncommittedChanges,
      moreAvailable,
    })

    if (buffered.error !== undefined) {
      const error = buffered.error
      streamIdRef.current = null
      setLoadMode('partial')
      setState({ phase: 'error', loaded, total, capped: cappedRef.current, error })
      resolvePending(false)
      return
    }

    if (buffered.done === true) {
      streamIdRef.current = null
      setLoadMode(moreAvailable ? 'partial' : 'full')
      const available = new Set(commitsRef.current.map((c) => c.hash))
      setSelection((prev) => {
        const next = prev.filter((hash) => available.has(hash))
        return next.length === prev.length && next.every((hash, i) => hash === prev[i])
          ? prev
          : next
      })
      setState({ phase: 'idle', loaded, total, capped: cappedRef.current, error: null })
      resolvePending(true)
      return
    }

    setState((prev) =>
      prev.phase === 'streaming' || prev.phase === 'counting' ? { ...prev, loaded, total } : prev,
    )
    resolvePending(true)
  }, [resolvePending, setLoadMode, setResult, setSelection])

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      flushBuffer()
    }, streamFlushInterval(commitsRef.current.length))
  }, [flushBuffer])

  const commitBatch = useCallback(
    async (batch: GitGraphCommitBatchDto): Promise<boolean> => {
      if (batch.streamId !== streamIdRef.current) return false
      const buffer = bufferRef.current
      if (batch.commits.length > 0) buffer.commits.push(...batch.commits)
      buffer.logCount += batch.logCount
      if (batch.meta) buffer.meta = batch.meta
      if (batch.done === true) buffer.done = true
      if (batch.moreAvailable === true) buffer.moreAvailable = true
      if (batch.error !== undefined) buffer.error = batch.error

      const terminal = batch.done === true || batch.error !== undefined
      const result = new Promise<boolean>((resolve) => {
        pendingResolversRef.current.push(resolve)
      })
      if (terminal) flushBuffer()
      else scheduleFlush()
      return result
    },
    [flushBuffer, scheduleFlush],
  )

  const loadAll = useCallback(() => {
    if (
      streamIdRef.current !== null ||
      phaseRef.current === 'counting' ||
      phaseRef.current === 'streaming'
    ) {
      return
    }
    const generation = ++generationRef.current
    const { order: nextOrder, includeRemotes: nextRemotes } = optionsRef.current
    setState({ phase: 'counting', loaded: 0, total: null, capped: false, error: null })

    void (async () => {
      try {
        const count = await commands.executeCommand<number>(GitGraphCommands.countCommits, {
          order: nextOrder,
          includeRemotes: nextRemotes,
        })
        if (!mountedRef.current || generation !== generationRef.current) return
        // 0 is also what the extension returns when the count fails; the button
        // is only visible when more commits exist, so treat 0 as "unknown".
        const total = typeof count === 'number' && count > 0 ? count : null

        if (total !== null && total > LOAD_ALL_CONFIRM_THRESHOLD) {
          const capped = total > LOAD_ALL_MAX_COMMITS
          const detail = capped
            ? localize(
                'gitGraph.loadAll.confirmCapped',
                'This repository has {total} commits. Only the first {max} will be loaded as a safety limit; the full history may use significant memory.',
                { total, max: LOAD_ALL_MAX_COMMITS },
              )
            : localize(
                'gitGraph.loadAll.confirmDetail',
                'This repository has {total} commits. Loading the full history may use significant memory.',
                { total },
              )
          const decision = await dialog.confirm({
            type: 'warning',
            message: localize('gitGraph.loadAll.confirm', 'Load all commits?'),
            detail,
            primaryButton: localize('gitGraph.loadAll.action', 'Load All'),
            cancelButton: localize('common.cancel', 'Cancel'),
          })
          if (!mountedRef.current || generation !== generationRef.current) return
          if (!decision.confirmed) {
            setState(IDLE_STREAM)
            return
          }
        }

        const capped = total !== null && total > LOAD_ALL_MAX_COMMITS
        totalRef.current = total
        receivedRef.current = 0
        cappedRef.current = capped
        bufferRef.current = { commits: [], logCount: 0 }
        streamStateRef.current = createStreamedCommitState()
        const streamId = `git-graph-${generation}-${Date.now()}`
        streamIdRef.current = streamId
        setState({ phase: 'streaming', loaded: 0, total, capped, error: null })

        const started = await commands.executeCommand<boolean>(GitGraphCommands.startCommitStream, {
          streamId,
          order: nextOrder,
          includeRemotes: nextRemotes,
          // Always cap, not only when the preflight count exceeded it: a failed
          // count reports 0 and must not turn the safety limit off.
          maxCommits: LOAD_ALL_MAX_COMMITS,
        })
        if (!mountedRef.current || generation !== generationRef.current) return
        if (started !== true) {
          streamIdRef.current = null
          setState({
            phase: 'error',
            loaded: 0,
            total,
            capped,
            error: localize('gitGraph.loadAll.failed', 'Failed to start loading commits.'),
          })
        }
      } catch (error) {
        if (!mountedRef.current || generation !== generationRef.current) return
        streamIdRef.current = null
        setState({
          phase: 'error',
          loaded: receivedRef.current,
          total: totalRef.current,
          capped: cappedRef.current,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }, [commands, dialog])

  const cancel = useCallback(() => {
    const streamId = streamIdRef.current
    if (streamId === null) {
      // Counting (preflight / confirm) has no child process yet; invalidating
      // the generation is enough to drop its continuation.
      if (phaseRef.current === 'counting') {
        generationRef.current++
        setState((prev) => ({ ...prev, phase: 'cancelled', error: null }))
        return
      }
      // No active stream: the caller is resetting the view (repo switch,
      // settings change). Clear residual capped/error notices too, otherwise a
      // previous repository's state keeps hiding the next one's Load all button.
      generationRef.current++
      totalRef.current = null
      cappedRef.current = false
      setState(IDLE_STREAM)
      return
    }
    // Apply whatever already arrived before declaring the list partial.
    flushBuffer()
    // flushBuffer handles a terminal batch that was buffered here; in that case
    // the stream already completed and must not be downgraded to partial.
    if (streamIdRef.current !== streamId) return
    streamIdRef.current = null
    generationRef.current++
    cappedRef.current = false
    setLoadMode('partial')
    setResult((prev) => (prev ? { ...prev, moreAvailable: true } : prev))
    setState((prev) => ({ ...prev, phase: 'cancelled', capped: false, error: null }))
    void commands
      .executeCommand(GitGraphCommands.cancelCommitStream, streamId)
      .catch(() => undefined)
  }, [commands, flushBuffer, setLoadMode, setResult])

  useEffect(() => {
    gitGraphViewState.loadAll = loadAll
    gitGraphViewState.cancelLoadAll = cancel
    return () => {
      gitGraphViewState.loadAll = null
      gitGraphViewState.cancelLoadAll = null
    }
  }, [loadAll, cancel])

  useEffect(() => {
    gitGraphViewState.commitBatch = commitBatch
    return () => {
      gitGraphViewState.commitBatch = null
      const streamId = streamIdRef.current
      streamIdRef.current = null
      if (streamId !== null) {
        // Tab switches unmount the editor; keep the cached result as partial so
        // the remount shallow-refreshes it instead of replacing it with a page.
        gitGraphViewState.loadMode = 'partial'
        void commands
          .executeCommand(GitGraphCommands.cancelCommitStream, streamId)
          .catch(() => undefined)
      }
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      pendingResolversRef.current = []
    }
  }, [commands, commitBatch])

  // Debug breadcrumbs are deliberately terse: the stream can emit dozens of
  // batches, and the logger is a shared output channel.
  useEffect(() => {
    if (state.phase === 'streaming') {
      loggerRef.current?.debug(
        `commit stream ${state.loaded}${state.total === null ? '' : `/${state.total}`}${state.capped ? ' (capped)' : ''}`,
      )
    }
  }, [state.phase, state.loaded, state.total, state.capped])

  return { state, loadAll, cancel, commitBatch }
}
