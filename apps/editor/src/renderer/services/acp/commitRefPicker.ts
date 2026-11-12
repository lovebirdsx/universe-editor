/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Interactive `#`-commit picker: resolves the currently-selected repo, loads its
 *  commit history via the git-graph extension's stateful commands, and lets the
 *  user pick one via a follow-up QuickPick. Split out from contextSuggestions.ts
 *  because that file's providers stay headless (no UI service deps); this one
 *  drives IQuickInputService directly.
 *--------------------------------------------------------------------------------------------*/

import type { GitGraphCommitDto } from '@universe-editor/extensions-common'
import {
  ICommandService,
  INotificationService,
  IQuickInputService,
  IWorkspaceService,
  type IQuickPickItem,
  localize,
  Severity,
} from '@universe-editor/platform'
import { relativeTime } from '../../relativeTime.js'
import { IScmService } from '../extensions/ScmService.js'
import {
  commitToRef,
  loadRepoCommits,
  resolveCommitRepoRoot,
  SHORT_HASH_LENGTH,
} from './commitRef.js'
import type { PromptRef } from './promptRef.js'

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

interface CommitQuickPickItem extends IQuickPickItem {
  readonly commit: GitGraphCommitDto
}

function formatCommitDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString()
}

function toQuickPickItem(commit: GitGraphCommitDto): CommitQuickPickItem {
  const shortHash = commit.hash.slice(0, SHORT_HASH_LENGTH)
  return {
    id: commit.hash,
    label: `${shortHash} ${commit.message}`,
    description: `${commit.author} · ${relativeTime(commit.date * 1000)}`,
    detail: formatCommitDate(commit.date),
    commit,
  }
}

/**
 * Drives the two-step `#` commit flow: resolve repo → setRepo/getCommits (the
 * git-graph extension's commands are stateful, no root param — see
 * GitGraphEditor.tsx's onSelectRepo for the same sequencing) → QuickPick → ref.
 */
export class CommitRefPicker {
  constructor(
    @ICommandService private readonly _commands: ICommandService,
    @IQuickInputService private readonly _quickInput: IQuickInputService,
    @IScmService private readonly _scm: IScmService,
    @INotificationService private readonly _notification: INotificationService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
  ) {}

  async pick(): Promise<PromptRef | undefined> {
    const root = resolveCommitRepoRoot(this._scm)
    if (!root) {
      this._notification.notify({
        severity: Severity.Warning,
        message: localize(
          'acp.contextRef.commit.noRepo',
          'No Git repository is open — cannot pick a commit.',
        ),
      })
      return undefined
    }

    const qp = this._quickInput.createQuickPick<CommitQuickPickItem>()
    qp.placeholder = localize('acp.contextRef.commit.placeholder', 'Select a commit from {repo}', {
      repo: basename(root),
    })
    qp.matchOnDescription = true
    qp.matchOnDetail = true
    // Keep the date order from getCommits (most recent first) even while
    // filtering — a relevance or MRU re-sort would scatter matching commits.
    qp.filterMode = 'fuzzyKeepOrder'
    // Rows carry a trailing `author · time` column: widen the panel and keep
    // the column intact (long subjects truncate with an ellipsis instead of
    // squeezing the metadata away).
    qp.width = 760
    qp.preserveDescription = true
    qp.busy = true
    qp.show()

    try {
      const commits = await loadRepoCommits(this._commands, root)
      qp.items = commits.map(toQuickPickItem)
      qp.busy = false
    } catch {
      // `hide()` — not `dispose()`, which only tears down the picker's emitters
      // and would strand the panel on screen with dead handlers.
      qp.hide()
      this._notification.notify({
        severity: Severity.Error,
        message: localize(
          'acp.contextRef.commit.loadFailed',
          'Failed to load commit history for {repo}.',
          { repo: basename(root) },
        ),
      })
      return undefined
    }

    const picked = await new Promise<GitGraphCommitDto | undefined>((resolve) => {
      const d1 = qp.onDidAccept((accepted) => {
        resolve(accepted[0]?.commit)
        d1.dispose()
        d2.dispose()
      })
      const d2 = qp.onDidHide(() => {
        resolve(undefined)
        d1.dispose()
        d2.dispose()
      })
    })
    qp.dispose()
    return picked ? commitToRef(picked, root, this._workspace.current?.folder) : undefined
  }
}
