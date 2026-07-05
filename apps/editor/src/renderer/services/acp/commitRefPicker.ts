/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Interactive `#`-commit picker: resolves the currently-selected repo, loads its
 *  commit history via the git-graph extension's stateful commands, and lets the
 *  user pick one via a follow-up QuickPick. Split out from contextSuggestions.ts
 *  because that file's providers stay headless (no UI service deps); this one
 *  drives IQuickInputService directly.
 *--------------------------------------------------------------------------------------------*/

import type { GitGraphCommitDto, GitGraphLoadResult } from '@universe-editor/extensions-common'
import { GitGraphCommands } from '@universe-editor/extensions-common'
import {
  generateUuid,
  ICommandService,
  INotificationService,
  IQuickInputService,
  type IQuickPickItem,
  localize,
  Severity,
  URI,
} from '@universe-editor/platform'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import { IScmService } from '../extensions/ScmService.js'
import type { PromptRef } from './promptRef.js'

const MAX_COMMITS = 200
const MAX_SUBJECT_LENGTH = 60
const SHORT_HASH_LENGTH = 7

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

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
    description: commit.author,
    detail: formatCommitDate(commit.date),
    commit,
  }
}

function commitToRef(commit: GitGraphCommitDto, repoRoot: string): PromptRef {
  const shortHash = commit.hash.slice(0, SHORT_HASH_LENGTH)
  const subject = truncate(commit.message, MAX_SUBJECT_LENGTH)
  return {
    id: generateUuid(),
    kind: 'commit',
    label: `${shortHash} ${subject}`,
    uri: URI.file(repoRoot).toString(),
    meta: { commitHash: commit.hash, description: commit.message },
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
  ) {}

  async pick(): Promise<PromptRef | undefined> {
    const root = this._resolveRepoRoot()
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
    qp.busy = true
    qp.show()

    try {
      await this._commands.executeCommand(GitGraphCommands.setRepo, root)
      const result = await this._commands.executeCommand<GitGraphLoadResult>(
        GitGraphCommands.getCommits,
        { maxCommits: MAX_COMMITS, order: 'date', includeRemotes: true },
      )
      qp.items = (result?.commits ?? []).map(toQuickPickItem)
      qp.busy = false
    } catch {
      qp.dispose()
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
    return picked ? commitToRef(picked, root) : undefined
  }

  private _resolveRepoRoot(): string | undefined {
    const controls = this._scm.sourceControls.get()
    if (controls.length === 0) return undefined
    const selected = scmViewState.selectedRepo.get()
    if (selected && controls.some((c) => c.rootUri === selected)) return selected
    return controls[0]?.rootUri
  }
}
