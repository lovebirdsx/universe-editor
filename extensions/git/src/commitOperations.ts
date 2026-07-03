import { window } from '@universe-editor/extension-api'
import { localize } from './nls.js'
import type { Repository } from './repository.js'

export type CommitRepository = Pick<
  Repository,
  | 'commitMessage'
  | 'hasStagedChanges'
  | 'hasChanges'
  | 'stageAll'
  | 'commit'
  | 'commitAmend'
  | 'getLastCommitMessage'
>

async function ensureStagedChanges(
  repo: CommitRepository,
  noChangesMessage: string,
): Promise<boolean> {
  if (repo.hasStagedChanges) return true
  if (!repo.hasChanges) {
    await window.showWarningMessage(noChangesMessage)
    return false
  }

  const staged = await repo.stageAll()
  if (!staged) return false
  if (repo.hasStagedChanges) return true

  await window.showWarningMessage(noChangesMessage)
  return false
}

export async function commitSmart(repo: CommitRepository | undefined): Promise<boolean> {
  if (!repo) return false
  const message = repo.commitMessage.trim()
  if (!message) {
    await window.showWarningMessage(
      localize('git.commit.noMessage', 'Type a commit message first.'),
    )
    return false
  }

  const canCommit = await ensureStagedChanges(
    repo,
    localize('git.commit.noChanges', 'There are no changes to commit.'),
  )
  if (!canCommit) return false

  const ok = await repo.commit(message)
  if (ok) repo.commitMessage = ''
  return ok
}

export async function commitAmendSmart(repo: CommitRepository | undefined): Promise<boolean> {
  if (!repo) return false

  const lastMsg = await repo.getLastCommitMessage()
  if (!lastMsg) {
    await window.showWarningMessage(localize('git.commit.noCommitsToAmend', 'No commits to amend.'))
    return false
  }

  const message = repo.commitMessage.trim()
  if (!message) {
    repo.commitMessage = lastMsg
    return false
  }

  if (!repo.hasStagedChanges) {
    if (repo.hasChanges) {
      const canAmend = await ensureStagedChanges(
        repo,
        localize('git.commit.noChangesToAmend', 'There are no changes to amend.'),
      )
      if (!canAmend) return false
    } else if (message === lastMsg.trim()) {
      await window.showWarningMessage(
        localize('git.commit.noChangesToAmend', 'There are no changes to amend.'),
      )
      return false
    }
  }

  const ok = await repo.commitAmend(message)
  if (ok) repo.commitMessage = ''
  return ok
}
