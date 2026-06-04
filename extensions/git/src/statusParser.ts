/**
 * Parser for `git status --porcelain=v2 --branch -z`. Pure and side-effect free
 * so it can be unit-tested against fixed fixtures.
 *
 * The `-z` form NUL-terminates every entry. Most entries are one field; a rename
 * / copy entry (type `2`) is two NUL-separated fields — the new path then the
 * original — so the parser consumes an extra token for those. Header lines start
 * with `# `, ordinary changes with `1 `, renames with `2 `, unmerged with `u `,
 * untracked with `? `, ignored with `! `.
 *
 * For changed entries the two-character `<XY>` field is the staged (X) and
 * working-tree (Y) status; `.` means unchanged on that side.
 */

export type GitFileKind = 'tracked' | 'untracked' | 'unmerged'

export interface GitFileStatus {
  /** Repo-relative path (the new path for renames). */
  readonly path: string
  /** Staged status char (X); `.` when unchanged in the index. */
  readonly index: string
  /** Working-tree status char (Y); `.` when unchanged on disk. */
  readonly workingTree: string
  readonly kind: GitFileKind
  /** Original path, for renames/copies. */
  readonly origPath?: string
}

export interface GitStatus {
  readonly branch: string | undefined
  readonly ahead: number
  readonly behind: number
  readonly files: readonly GitFileStatus[]
}

export function parseStatus(raw: string): GitStatus {
  const tokens = raw.split('\0')
  let branch: string | undefined
  let ahead = 0
  let behind = 0
  const files: GitFileStatus[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue

    if (token.startsWith('# ')) {
      const header = token.slice(2)
      if (header.startsWith('branch.head ')) {
        const name = header.slice('branch.head '.length)
        branch = name === '(detached)' ? undefined : name
      } else if (header.startsWith('branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(header)
        if (m) {
          ahead = Number(m[1])
          behind = Number(m[2])
        }
      }
      continue
    }

    if (token.startsWith('1 ')) {
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      files.push({
        path: parts.slice(8).join(' '),
        index: xy[0] ?? '.',
        workingTree: xy[1] ?? '.',
        kind: 'tracked',
      })
      continue
    }

    if (token.startsWith('2 ')) {
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      // The original path follows in the next NUL-separated token.
      const origPath = tokens[++i] ?? ''
      files.push({
        path: parts.slice(9).join(' '),
        index: xy[0] ?? '.',
        workingTree: xy[1] ?? '.',
        kind: 'tracked',
        origPath,
      })
      continue
    }

    if (token.startsWith('u ')) {
      const parts = token.split(' ')
      files.push({
        path: parts.slice(10).join(' '),
        index: 'U',
        workingTree: 'U',
        kind: 'unmerged',
      })
      continue
    }

    if (token.startsWith('? ')) {
      files.push({
        path: token.slice(2),
        index: '.',
        workingTree: '?',
        kind: 'untracked',
      })
      continue
    }

    // '! ' (ignored) and anything else are dropped.
  }

  return { branch, ahead, behind, files }
}
