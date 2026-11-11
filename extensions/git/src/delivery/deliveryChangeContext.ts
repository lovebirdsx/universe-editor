/**
 * Snapshot of a worktree's pending changes, sized for a commit-message prompt.
 * The fingerprint lets the orchestrator detect that the user (or an agent)
 * changed the tree while the message was being generated, in which case the
 * commit is abandoned instead of committing a stale message.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import {
  buildUntrackedPatch,
  MAX_UNTRACKED_READ_BYTES,
  truncateFileDiff,
} from '../commitContext.js'
import { gitErrorText } from '../gitError.js'
import type { GitFileStatus } from '../statusParser.js'
import { readWorktreeStatus, runDeliveryGit } from './deliveryGit.js'
import type {
  DeliveryChangeContextData,
  DeliveryChangeContextInput,
  DeliveryChangeContextResult,
  DeliveryChangeFile,
} from './deliveryTypes.js'

type Log = ((msg: string) => void) | undefined

const DEFAULT_MAX_FILES = 50
const DEFAULT_MAX_CHARS = 60_000
const PER_FILE_DIFF_CHARS = 12_000
const STATUS_TIMEOUT_MS = 30_000

const statusLabel = (file: GitFileStatus): string => `${file.index}${file.workingTree}`

const safeRelative = (path: string): boolean => {
  if (isAbsolute(path)) return false
  const normalized = normalize(path).replace(/\\/g, '/')
  return normalized !== '..' && !normalized.startsWith('../')
}

interface UntrackedContent {
  readonly content: string
  readonly note?: string
}

const readUntracked = async (root: string, path: string): Promise<UntrackedContent | undefined> => {
  if (!safeRelative(path)) return undefined
  const absolute = join(root, path)
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return { content: '', note: '[not a regular file]' }
    const truncated = info.size > MAX_UNTRACKED_READ_BYTES
    const buffer = await readFile(absolute)
    const slice = truncated ? buffer.subarray(0, MAX_UNTRACKED_READ_BYTES) : buffer
    if (slice.includes(0)) {
      return { content: '', note: `[binary file: ${info.size} bytes]` }
    }
    const text = slice.toString('utf8')
    return truncated
      ? { content: text, note: `[file truncated: ${info.size - slice.length} bytes omitted]` }
      : { content: text }
  } catch {
    return undefined
  }
}

export async function readDeliveryChangeContext(
  input: DeliveryChangeContextInput,
  log?: Log,
): Promise<DeliveryChangeContextResult> {
  if (typeof input?.sourceWorktree !== 'string' || input.sourceWorktree.length === 0) {
    return {
      ok: false,
      error: { code: 'not_a_repository', message: 'The source worktree path is missing.' },
    }
  }
  const rootRes = await runDeliveryGit(
    ['rev-parse', '--show-toplevel'],
    input.sourceWorktree,
    log,
    { timeoutMs: STATUS_TIMEOUT_MS },
  )
  if (rootRes.exitCode !== 0) {
    return {
      ok: false,
      error: {
        code: 'not_a_repository',
        message: 'The source worktree is not inside a git repository.',
        detail: gitErrorText(rootRes),
      },
    }
  }
  const root = rootRes.stdout.trim()
  const status = await readWorktreeStatus(input.sourceWorktree, log)
  if (status === undefined) {
    return {
      ok: false,
      error: { code: 'git_failed', message: 'Could not read git status.' },
    }
  }
  if (status.files.length === 0) {
    return {
      ok: false,
      error: { code: 'nothing_to_commit', message: 'The source worktree is clean.' },
    }
  }

  const maxFiles = Math.max(1, input.maxFiles ?? DEFAULT_MAX_FILES)
  const maxChars = Math.max(1000, input.maxChars ?? DEFAULT_MAX_CHARS)
  const statusText = status.files.map((file) => `${statusLabel(file)} ${file.path}`).join('\n')
  const hash = createHash('sha1')
  hash.update(statusText)

  const selected = status.files.slice(0, maxFiles)
  const files: DeliveryChangeFile[] = []
  let usedChars = 0
  let truncated = selected.length < status.files.length

  for (const file of selected) {
    hash.update('\0').update(statusLabel(file)).update('\0').update(file.path)
    let rawDiff = ''
    if (file.kind === 'untracked') {
      const read = await readUntracked(root, file.path)
      if (read === undefined) continue
      const patch = buildUntrackedPatch(file.path, read.content)
      rawDiff = read.note === undefined ? patch : `${patch}\n${read.note}`
      hash
        .update('\0')
        .update(read.content)
        .update(read.note ?? '')
    } else {
      const diff = await runDeliveryGit(
        ['diff', '--no-color', '--no-ext-diff', '--unified=3', 'HEAD', '--', file.path],
        input.sourceWorktree,
        log,
        { timeoutMs: STATUS_TIMEOUT_MS },
      )
      if (diff.exitCode !== 0) continue
      rawDiff = diff.stdout
      hash.update('\0').update(rawDiff)
    }

    const remaining = maxChars - usedChars
    if (remaining <= 0) {
      truncated = true
      break
    }
    const budget = Math.min(PER_FILE_DIFF_CHARS, remaining)
    const shown = truncateFileDiff(rawDiff, budget)
    if (shown.length < rawDiff.length) truncated = true
    usedChars += shown.length
    files.push({ path: file.path, status: statusLabel(file), diff: shown })
  }

  const data: DeliveryChangeContextData = {
    files,
    totalFiles: status.files.length,
    truncated,
    fingerprint: hash.digest('hex'),
    statusText,
  }
  return { ok: true, ...data }
}
