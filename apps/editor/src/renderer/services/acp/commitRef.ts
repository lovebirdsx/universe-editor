/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared commit-ref helpers: the desktop `#`-commit picker and the mobile gateway resolve
 *  the same repo/commit list, and both must build the ref through one path. The git-graph
 *  commands are stateful (setRepo then getCommits), so their calls are serialized here to
 *  keep the picker and the mobile resolver from overwriting each other's repo.
 *--------------------------------------------------------------------------------------------*/

import type { GitGraphCommitDto, GitGraphLoadResult } from '@universe-editor/extensions-common'
import { GitGraphCommands } from '@universe-editor/extensions-common'
import {
  absolutePathToWorkspaceUri,
  generateUuid,
  ICommandService,
  type URI,
} from '@universe-editor/platform'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import type { IScmService } from '../extensions/ScmService.js'
import type { PromptRef } from './promptRef.js'

export const MAX_COMMITS = 200
export const MAX_COMMIT_SUBJECT_LENGTH = 60
export const SHORT_HASH_LENGTH = 7

export interface CommitRefParts {
  readonly label: string
  readonly uri: string
  readonly commitHash: string
  readonly description: string
}

export function commitLabel(hash: string, message: string): string {
  const subject =
    message.length > MAX_COMMIT_SUBJECT_LENGTH
      ? `${message.slice(0, MAX_COMMIT_SUBJECT_LENGTH - 1)}…`
      : message
  return `${hash.slice(0, SHORT_HASH_LENGTH)} ${subject}`
}

export function commitRefFromParts(parts: CommitRefParts): PromptRef {
  return {
    id: generateUuid(),
    kind: 'commit',
    label: parts.label,
    uri: parts.uri,
    meta: { commitHash: parts.commitHash, description: parts.description },
  }
}

export function commitToRef(
  commit: GitGraphCommitDto,
  repoRoot: string,
  folder: URI | undefined,
): PromptRef {
  return commitRefFromParts({
    label: commitLabel(commit.hash, commit.message),
    uri: absolutePathToWorkspaceUri(repoRoot, folder).toString(),
    commitHash: commit.hash,
    description: commit.message,
  })
}

/** Selected SCM repo (desktop picker semantics), else the first one. */
export function resolveCommitRepoRoot(scm: IScmService): string | undefined {
  const controls = scm.sourceControls.get()
  if (controls.length === 0) return undefined
  const selected = scmViewState.selectedRepo.get()
  if (selected && controls.some((c) => c.rootUri === selected)) return selected
  return controls[0]?.rootUri
}

/** Git-only: mobile gates the commit entry on a real Git repo (P4-only workspaces get none). */
export function resolveGitRepoRoot(scm: IScmService): string | undefined {
  const roots = scm.sourceControls.get().filter((c) => c.id === 'git' && c.rootUri !== undefined)
  if (roots.length === 0) return undefined
  const selected = scmViewState.selectedRepo.get()
  const picked = roots.find((c) => c.rootUri === selected) ?? roots[0]
  return picked?.rootUri
}

let commitQueue: Promise<unknown> = Promise.resolve()

/**
 * Load commits for `repoRoot`. The queue serializes the whole setRepo→getCommits pair:
 * git-graph keeps the repo on module state, so two interleaved pairs would read the
 * wrong repo. Failures do not poison the queue.
 */
export function loadRepoCommits(
  commands: ICommandService,
  repoRoot: string,
  maxCommits: number = MAX_COMMITS,
): Promise<readonly GitGraphCommitDto[]> {
  const run = commitQueue.then(async () => {
    await commands.executeCommand(GitGraphCommands.setRepo, repoRoot)
    const result = await commands.executeCommand<GitGraphLoadResult>(GitGraphCommands.getCommits, {
      maxCommits,
      order: 'date',
      includeRemotes: true,
    })
    return result?.commits ?? []
  })
  commitQueue = run.catch(() => undefined)
  return run
}
