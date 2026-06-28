/**
 * Git Graph wire types, shared by the renderer (which calls the commands) and,
 * structurally, by the `git` extension (which implements them — the extension
 * keeps a local copy of these shapes to avoid bundling this package).
 *
 * Data crosses the contributed-command boundary as plain JSON: the renderer
 * calls `commands.executeCommand(GitGraphCommands.*, ...)` and the `git`
 * extension's handler returns one of the DTOs below. Hashes are full 40-char
 * SHA-1; dates are Unix seconds (author date).
 */

/** A tag ref pointing at a commit. */
export interface GitGraphTagDto {
  name: string
  /** Annotated (`git tag -a`) vs lightweight. */
  annotated: boolean
}

/** A remote-tracking branch pointing at a commit, e.g. `origin/main`. */
export interface GitGraphRemoteDto {
  /** Full short name including the remote, e.g. `origin/main`. */
  name: string
  /** The owning remote (`origin`), or null when it can't be resolved. */
  remote: string | null
}

/** Present only when a commit node represents a stash entry. */
export interface GitGraphStashDto {
  /** Reflog selector, e.g. `stash@{0}`. */
  selector: string
  /** The commit the stash was created on top of. */
  baseHash: string
}

/** A linked working tree whose HEAD points at a commit. */
export interface GitGraphWorktreeDto {
  /** Absolute path of the worktree's folder on disk. */
  path: string
  /** Display name (the folder basename). */
  name: string
  /** Branch the worktree has checked out, or null when detached. */
  branch: string | null
  /** True for the worktree this window is currently opened on. */
  isCurrent: boolean
  /** True for the main working tree (cannot be removed). */
  isMain: boolean
}

/** A single commit node, with refs that point at it already attached. */
export interface GitGraphCommitDto {
  hash: string
  parents: string[]
  author: string
  email: string
  /** Author date, Unix seconds. */
  date: number
  /** Commit subject (first line). Full body is fetched on demand. */
  message: string
  /** Local branch names whose tip is this commit. */
  heads: string[]
  tags: GitGraphTagDto[]
  remotes: GitGraphRemoteDto[]
  /** Set when this node is a stash entry, else null. */
  stash: GitGraphStashDto | null
  /** Linked working trees whose HEAD is this commit. Empty unless the repo uses worktrees. */
  worktrees: GitGraphWorktreeDto[]
}

/** A git repository the Git Graph view can switch between (main repo + submodules). */
export interface GitGraphRepoDto {
  /** Absolute path of the repository root. */
  root: string
  /** Display name (basename for the main repo, relative path for submodules). */
  name: string
}

/** Options for `git-graph.getCommits`. */
export interface GitGraphLoadOptions {
  /** Upper bound on commits returned. */
  maxCommits?: number
  /** Commit ordering. Defaults to `date`. */
  order?: 'date' | 'author-date' | 'topo'
  /** Include remote-tracking branches as starting refs. Defaults to true. */
  includeRemotes?: boolean
}

/** Result of `git-graph.getCommits`. */
export interface GitGraphLoadResult {
  commits: GitGraphCommitDto[]
  /** Commit hash HEAD points at, or null in an unborn repo. */
  head: string | null
  /** Current branch name, or null when detached. */
  headName: string | null
  /** True when more commits exist beyond `maxCommits`. */
  moreAvailable: boolean
  /** Number of changed files in the working tree (staged + unstaged + untracked). */
  uncommittedChanges: number
}

/** A single file changed by a commit (or between two commits). */
export interface GitGraphFileChangeDto {
  /** Single-letter status: A/M/D/R/C/T/U. */
  status: string
  /** Current path (the new path for renames/copies). */
  path: string
  /** Original path for renames/copies, else null. */
  oldPath: string | null
}

/** Full detail of one commit, loaded on demand when a row is selected. */
export interface GitGraphCommitDetailsDto {
  hash: string
  parents: string[]
  author: string
  authorEmail: string
  /** Author date, Unix seconds. */
  authorDate: number
  committer: string
  committerEmail: string
  /** Committer date, Unix seconds. */
  committerDate: number
  /** Full commit message (subject + body). */
  body: string
  files: GitGraphFileChangeDto[]
}

/** Argument for `git-graph.openFileDiff` — opens a file's diff in a diff editor. */
export interface GitGraphFileDiffRequest {
  /** Base revision (left side); a commit's first parent, or the compare base. */
  fromHash: string
  /** Target revision (right side); the commit itself, or the compare target. */
  toHash: string
  /** Current path of the file. */
  path: string
  /** Original path, for renames/copies. */
  oldPath?: string
  /** Single-letter status, see {@link GitGraphFileChangeDto.status}. */
  status: string
}

/**
 * Contributed-command ids the `git` extension registers for the Git Graph view.
 * Kept here as the single source of truth for the renderer side.
 */
export const GitGraphCommands = {
  getRepos: 'git-graph.getRepos',
  setRepo: 'git-graph.setRepo',
  getCommits: 'git-graph.getCommits',
  getCommitDetails: 'git-graph.getCommitDetails',
  getUncommittedChanges: 'git-graph.getUncommittedChanges',
  compareCommits: 'git-graph.compareCommits',
  openFileDiff: 'git-graph.openFileDiff',
  openWorkingTreeFile: 'git-graph.openWorkingTreeFile',
  openWorktree: 'git-graph.openWorktree',
  deleteWorktree: 'git-graph.deleteWorktree',
  // Mutating operations — each returns a boolean (ok). Errors are surfaced by the
  // extension; the renderer refreshes the graph afterwards regardless.
  checkout: 'git-graph.checkout',
  cherrypick: 'git-graph.cherrypick',
  revert: 'git-graph.revert',
  reset: 'git-graph.reset',
  merge: 'git-graph.merge',
  rebase: 'git-graph.rebase',
  createBranch: 'git-graph.createBranch',
  renameBranch: 'git-graph.renameBranch',
  deleteBranch: 'git-graph.deleteBranch',
  pushBranch: 'git-graph.pushBranch',
  checkoutRemote: 'git-graph.checkoutRemote',
  deleteRemoteBranch: 'git-graph.deleteRemoteBranch',
  createTag: 'git-graph.createTag',
  deleteTag: 'git-graph.deleteTag',
  pushTag: 'git-graph.pushTag',
  stashApply: 'git-graph.stashApply',
  stashPop: 'git-graph.stashPop',
  stashDrop: 'git-graph.stashDrop',
} as const

export type GitGraphCommandId = (typeof GitGraphCommands)[keyof typeof GitGraphCommands]
