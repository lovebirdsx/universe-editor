/**
 * Shared `git log` wire parsing for the Git Graph, used by both the one-shot
 * `getCommits` path and the incremental stream. Keeping the format, the rev
 * arguments and the record parser in one place is deliberate: the two paths
 * must select and decode exactly the same commit set.
 */
import { StringDecoder } from 'node:string_decoder'
import type {
  GitGraphCommitDto,
  GitGraphRemoteDto,
  GitGraphStreamOptions,
  GitGraphTagDto,
} from '@universe-editor/extensions-common'

/** Field separator inside a record; record separator is NUL (`git -z`). */
export const FIELD = '\x1f'

/** The fields `mapLogRecord` expects, in order. */
export const LOG_FORMAT = `%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s`

/** Ref maps needed to enrich a parsed commit. */
export interface LogRefs {
  heads: Map<string, string[]>
  tags: Map<string, GitGraphTagDto[]>
  remotes: Map<string, GitGraphRemoteDto[]>
}

export interface LogArgsOptions {
  order?: GitGraphStreamOptions['order']
  includeRemotes?: boolean
  maxCount?: number
}

export function orderFlag(order?: GitGraphStreamOptions['order']): string {
  switch (order) {
    case 'author-date':
      return '--author-date-order'
    case 'topo':
      return '--topo-order'
    default:
      return '--date-order'
  }
}

/** The revision set the graph covers (`refs/stash` is added separately). */
export function buildRefArgs(includeRemotes: boolean): string[] {
  const args = ['--branches', '--tags']
  if (includeRemotes) args.push('--remotes')
  args.push('HEAD')
  return args
}

export function buildLogArgs(opts: LogArgsOptions): string[] {
  const args = ['log', '-z', `--format=${LOG_FORMAT}`, orderFlag(opts.order)]
  if (opts.maxCount !== undefined) args.push(`--max-count=${opts.maxCount}`)
  args.push(...buildRefArgs(opts.includeRemotes !== false))
  return args
}

/** Decode one NUL-delimited log record into the graph DTO. */
export function mapLogRecord(record: string, refs: LogRefs): GitGraphCommitDto {
  const [hash, parentsStr, author, email, at, ...subjectParts] = record.split(FIELD)
  // `%s` never contains FIELD, but rejoin defensively.
  const h = hash ?? ''
  return {
    hash: h,
    parents: parentsStr ? parentsStr.split(' ').filter(Boolean) : [],
    author: author ?? '',
    email: email ?? '',
    date: Number(at ?? 0),
    message: subjectParts.join(FIELD),
    heads: refs.heads.get(h) ?? [],
    tags: refs.tags.get(h) ?? [],
    remotes: refs.remotes.get(h) ?? [],
    stash: null,
    worktrees: [],
  }
}

/**
 * Incremental NUL-delimited parser. `StringDecoder` holds multi-byte UTF-8
 * sequences split across chunks (commit subjects in this repository are often
 * Chinese); the string carry holds a record split across chunks.
 */
export class CommitLogParser {
  private readonly _decoder = new StringDecoder('utf8')
  private _carry = ''

  /** Feed a stdout chunk and return every complete record it completed. */
  push(chunk: Buffer): string[] {
    this._carry += this._decoder.write(chunk)
    const records: string[] = []
    let idx = this._carry.indexOf('\0')
    while (idx >= 0) {
      const record = this._carry.slice(0, idx)
      this._carry = this._carry.slice(idx + 1)
      if (record) records.push(record)
      idx = this._carry.indexOf('\0')
    }
    return records
  }

  /**
   * Flush the decoder. `complete: false` drops the trailing partial record —
   * used when the process exited non-zero, where it is likely truncated.
   */
  end(complete = true): string[] {
    this._carry += this._decoder.end()
    const records: string[] = []
    if (complete && this._carry) records.push(this._carry)
    this._carry = ''
    return records
  }
}
