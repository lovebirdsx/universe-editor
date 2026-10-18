/**
 * Streaming `git log` for the Git Graph. One child process reads the full log
 * and pushes batches to the renderer through the `_workbench.*` command bridge.
 * Awaiting each push inside `for await (const chunk of child.stdout)` pauses the
 * stdout stream, which propagates backpressure to git; without that, a large
 * repository would buffer the entire log in the extension host.
 */
import type {
  GitGraphCommitBatchDto,
  GitGraphCommitDto,
  GitGraphStreamMetaDto,
  GitGraphStreamOptions,
} from '@universe-editor/extensions-common'
import { buildLogArgs, CommitLogParser, mapLogRecord } from './gitLogStream.js'
import { gitSpawnStream } from './gitService.js'
import {
  loadGraphMetadata,
  type GitGraphLoadOptions,
  type GitGraphMetadata,
  type Log,
} from './gitGraphSource.js'

/** Commits per renderer batch. Large enough to amortize RPC, small enough to show progress. */
const BATCH_SIZE = 1000
/** A renderer that stops answering must not pin a git process forever. */
const SEND_TIMEOUT_MS = 10_000

export type CommitBatchEmitter = (batch: GitGraphCommitBatchDto) => Promise<boolean>

interface TerminalBatch {
  done?: boolean
  moreAvailable?: boolean
  error?: string
}

interface ActiveStream {
  cancel(): void
}

const activeStreams = new Map<string, ActiveStream>()

/** Cancel one stream. Returns false when it already finished or was replaced. */
export function cancelCommitStream(streamId: string): boolean {
  const stream = activeStreams.get(streamId)
  if (!stream) return false
  stream.cancel()
  activeStreams.delete(streamId)
  return true
}

/** Cancel every active stream (repo switch, extension deactivate). */
export function cancelAllCommitStreams(): void {
  for (const stream of [...activeStreams.values()]) stream.cancel()
  activeStreams.clear()
}

export interface StartCommitStreamOptions extends GitGraphStreamOptions {
  /** Absolute path of the open workspace folder, used to mark the current worktree. */
  workspaceRoot?: string
}

/**
 * Start streaming. Resolves once the child has actually spawned so a missing
 * git binary surfaces as a command rejection instead of a silent no-op; the
 * log itself continues in the background.
 */
export async function startCommitStream(
  root: string,
  opts: StartCommitStreamOptions,
  emit: CommitBatchEmitter,
  log?: Log,
): Promise<boolean> {
  // The graph is a singleton; a new stream always supersedes the old one.
  cancelAllCommitStreams()

  const parser = new CommitLogParser()
  const args = buildLogArgs({
    ...(opts.order !== undefined ? { order: opts.order } : {}),
    includeRemotes: opts.includeRemotes !== false,
    ...(opts.maxCommits !== undefined ? { maxCount: opts.maxCommits } : {}),
  })
  const { child, done } = gitSpawnStream(args, root, log)
  // A spawn failure rejects `done`; the handshake below is what reports it, and
  // `run()` never gets to attach a handler.
  void done.catch(() => undefined)

  let cancelled = false
  let resolveAbort: (() => void) | undefined
  const aborted = new Promise<'aborted'>((resolve) => {
    resolveAbort = () => resolve('aborted')
  })

  const stream: ActiveStream = {
    cancel(): void {
      if (cancelled) return
      cancelled = true
      resolveAbort?.()
      child.kill()
    },
  }
  activeStreams.set(opts.streamId, stream)

  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const cleanup = (): void => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  }).catch((error: unknown) => {
    activeStreams.delete(opts.streamId)
    throw error
  })

  void run()
  return true

  async function send(batch: GitGraphCommitBatchDto): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SEND_TIMEOUT_MS)
    })
    try {
      const result = await Promise.race([
        emit(batch)
          .then((ok): 'ok' | 'gone' => (ok ? 'ok' : 'gone'))
          .catch((): 'gone' => 'gone'),
        aborted,
        timeout,
      ])
      return result === 'ok'
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function run(): Promise<void> {
    let seq = 0
    let batch: GitGraphCommitDto[] = []
    let batchLogCount = 0
    let metaDto: GitGraphStreamMetaDto = {
      head: null,
      headName: null,
      uncommittedChanges: 0,
    }

    const flush = async (terminal?: TerminalBatch): Promise<boolean> => {
      if (batch.length === 0 && terminal?.done !== true) return true
      const includeMeta = seq === 0
      const payload: GitGraphCommitBatchDto = {
        streamId: opts.streamId,
        seq: seq++,
        commits: batch,
        logCount: batchLogCount,
        ...(includeMeta ? { meta: metaDto } : {}),
        ...(terminal ?? {}),
      }
      batch = []
      batchLogCount = 0
      return send(payload)
    }

    try {
      const metaPromise = loadGraphMetadata(root, opts as GitGraphLoadOptions, log).catch(
        (error: unknown) => {
          log?.(`[git] git graph metadata failed: ${String(error)}`)
          return null
        },
      )
      // The stdout reader must be attached before any await: git can write the
      // whole log and exit while metadata is still loading, and an unpumped
      // child stream is closed with its buffered output.
      let refs: GitGraphMetadata['refs'] = {
        head: null,
        headName: null,
        heads: new Map<string, string[]>(),
        tags: new Map(),
        remotes: new Map(),
      }
      let worktrees: GitGraphMetadata['worktrees'] = null
      let stashes: GitGraphMetadata['stashes'] = []
      let metaReady: Promise<void> | null = null
      const ensureMeta = (): Promise<void> => {
        metaReady ??= (async () => {
          const meta = await metaPromise
          if (!meta) return
          refs = meta.refs
          worktrees = meta.worktrees
          stashes = [...meta.stashes].sort((a, b) => b.date - a.date)
          metaDto = {
            head: meta.refs.head,
            headName: meta.refs.headName,
            uncommittedChanges: meta.uncommittedChanges,
          }
        })()
        return metaReady
      }

      let received = 0
      let stashIndex = 0

      const ingest = async (records: readonly string[]): Promise<boolean> => {
        await ensureMeta()
        for (const record of records) {
          if (cancelled) return false
          const commit = mapLogRecord(record, refs)
          if (worktrees) {
            const wts = worktrees.get(commit.hash)
            if (wts) commit.worktrees = wts
          }
          // Mirrors mergeByDateDesc: a stash is emitted after every commit whose
          // date is >= the stash date, i.e. before the first strictly older one.
          while (stashIndex < stashes.length && stashes[stashIndex]!.date > commit.date) {
            batch.push(stashes[stashIndex]!)
            stashIndex++
          }
          batch.push(commit)
          batchLogCount++
          received++
          if (batch.length >= BATCH_SIZE) {
            if (!(await flush())) return false
          }
          if (opts.maxCommits !== undefined && received >= opts.maxCommits) return true
        }
        return true
      }

      let streamOk = true
      let hitCap = false
      for await (const chunk of child.stdout) {
        if (cancelled) break
        if (!(await ingest(parser.push(chunk as Buffer)))) {
          streamOk = false
          break
        }
        if (opts.maxCommits !== undefined && received >= opts.maxCommits) {
          hitCap = true
          break
        }
      }

      // Stop git instead of draining history we will discard. Breaking out of
      // the stdout iterator alone makes git die of SIGPIPE, whose non-zero exit
      // would otherwise be reported as a stream error.
      if (hitCap) child.kill()
      const result = await done.catch((error: unknown) => ({
        stdout: '',
        stderr: String(error),
        exitCode: -1,
      }))
      if (cancelled) return
      // The log may produce no chunk at all (empty history); the terminal batch
      // still needs metadata for its head/uncommitted/stash fields.
      await ensureMeta()

      // A non-zero exit may have truncated the final record; only flush the tail
      // when the process completed normally. At the cap the remaining records
      // were intentionally discarded, so there is no tail to add either.
      if (streamOk && !hitCap) {
        const tail = parser.end(result.exitCode === 0)
        if (tail.length && !(await ingest(tail))) streamOk = false
      }

      // Any stashes left are newer than the last emitted commit (or the log was
      // empty) — they belong at the end of the list.
      if (!hitCap) {
        while (stashIndex < stashes.length) {
          batch.push(stashes[stashIndex]!)
          stashIndex++
        }
      }

      if (!streamOk) {
        stream.cancel()
        return
      }
      if (!hitCap && result.exitCode !== 0) {
        await flush({
          done: true,
          error: result.stderr.trim() || `git log exited with ${result.exitCode}`,
        })
        return
      }
      const moreAvailable = hitCap || (opts.maxCommits !== undefined && received >= opts.maxCommits)
      await flush({
        done: true,
        ...(moreAvailable ? { moreAvailable } : {}),
      })
    } catch (error) {
      log?.(`[git] git graph stream failed: ${String(error)}`)
      if (!cancelled) {
        await flush({ done: true, error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      activeStreams.delete(opts.streamId)
    }
  }
}
