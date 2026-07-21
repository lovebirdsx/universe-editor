/**
 * Git blame data source. Runs `git blame --incremental` and assembles the JSON
 * the renderer's inline-blame annotations need. Read-only.
 *
 * The single source of truth for the returned shape is `BlameResultDto` in
 * `@universe-editor/extensions-common`; we alias its `BlameInfoDto`/`BlameResultDto`
 * to the local names via `import type` so this esbuild-bundled extension doesn't
 * pull that package (and its platform dep) into its bundle.
 *
 * `--incremental` streams one block per commit: a header line
 * `<40-hex-hash> <orig-line> <final-line> <num-lines>`, optional metadata lines
 * (`author`, `author-mail`, `author-time`, `summary`, …) present only the first
 * time a commit appears, and a closing `filename <path>` line. Uncommitted lines
 * carry an all-zero hash.
 */
import { relative } from 'node:path'
import type { BlameInfoDto, BlameResultDto } from '@universe-editor/extensions-common'
import { gitExec } from './gitService.js'

export type BlameInfo = BlameInfoDto
export type BlameResult = BlameResultDto

type Log = ((msg: string) => void) | undefined

const UNCOMMITTED_HASH = '0000000000000000000000000000000000000000'

/** Get blame for `absPath` within `repoRoot`, or null when git blame fails. */
export async function getBlame(
  repoRoot: string,
  absPath: string,
  options?: { ignoreWhitespace?: boolean },
  log?: Log,
): Promise<BlameResult | null> {
  const rel = relative(repoRoot, absPath).replace(/\\/g, '/')
  const args = ['blame', '--root', '--incremental']
  if (options?.ignoreWhitespace) args.push('-w')
  args.push('--', rel)
  const res = await gitExec(args, repoRoot, log)
  if (res.exitCode !== 0) return null
  return parseIncrementalBlame(res.stdout)
}

export function parseIncrementalBlame(data: string): BlameResult {
  const commits = new Map<string, BlameInfo>()
  const uncommitted: number[] = []

  let hash: string | undefined
  let startLine: number | undefined
  let lineCount: number | undefined
  let authorName = ''
  let authorEmail = ''
  let authorDate = 0
  let summary = ''

  const reset = (): void => {
    hash = undefined
    startLine = undefined
    lineCount = undefined
    authorName = ''
    authorEmail = ''
    authorDate = 0
    summary = ''
  }

  for (const line of data.split(/\r?\n/)) {
    if (!hash) {
      const header = /^([0-9a-f]{40}) \d+ (\d+) (\d+)$/.exec(line)
      if (header) {
        hash = header[1]
        startLine = Number(header[2])
        lineCount = Number(header[3])
      }
      continue
    }

    if (line.startsWith('author ')) {
      authorName = line.slice('author '.length)
    } else if (line.startsWith('author-mail ')) {
      authorEmail = line.slice('author-mail '.length).replace(/^<|>$/g, '')
    } else if (line.startsWith('author-time ')) {
      authorDate = Number(line.slice('author-time '.length)) * 1000
    } else if (line.startsWith('summary ')) {
      summary = line.slice('summary '.length)
    } else if (line.startsWith('filename ')) {
      const start = startLine ?? 1
      const end = start + (lineCount ?? 1) - 1

      if (hash === UNCOMMITTED_HASH) {
        for (let l = start; l <= end; l++) uncommitted.push(l)
      } else {
        const existing = commits.get(hash)
        if (existing) {
          existing.ranges.push({ startLine: start, endLine: end })
        } else {
          commits.set(hash, {
            hash,
            authorName,
            authorEmail,
            authorDate,
            summary,
            ranges: [{ startLine: start, endLine: end }],
          })
        }
      }
      reset()
    }
  }

  return { commits: [...commits.values()], uncommittedLines: uncommitted }
}
