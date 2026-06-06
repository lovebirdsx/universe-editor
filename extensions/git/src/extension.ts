/**
 * Git extension entry. Detects the repository containing the open workspace
 * folder, surfaces it through the SCM API (staged / working-tree groups driven
 * by real `git status` output), and wires the stage/unstage/commit/refresh/
 * checkout commands to the `git` CLI. A filesystem watcher keeps the view live.
 *
 * `activate` runs inside the extension host process; the host injects the API
 * and the open folder via `workspace.rootPath`. Everything is registered on
 * `context.subscriptions` so it is torn down on deactivate.
 */
import { commands, workspace, window, type ExtensionContext } from '@universe-editor/extension-api'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectRepoRoot } from './gitService.js'
import { Repository } from './repository.js'
import {
  getCommits as getGitGraphCommits,
  getCommitDetails as getGitGraphCommitDetails,
  getUncommittedChanges as getGitGraphUncommittedChanges,
  getRepos as getGitGraphRepos,
  compareCommits as compareGitGraphCommits,
  getFileDiffContent as getGitGraphFileDiffContent,
  type GitGraphLoadOptions,
  type GitGraphFileDiffRequest,
} from './gitGraphSource.js'
import * as gga from './gitGraphActions.js'

function resourcePath(arg: unknown): string | undefined {
  return (arg as { resourceUri?: string } | undefined)?.resourceUri
}

function resourceLetter(arg: unknown): string | undefined {
  return (arg as { contextValue?: string } | undefined)?.contextValue
}

function isDirectoryArg(arg: unknown): boolean {
  return (arg as { isDirectory?: boolean } | undefined)?.isDirectory === true
}

export async function activate(context: ExtensionContext): Promise<void> {
  const root = workspace.rootPath
  if (!root) {
    console.error('[git] no workspace folder open; git source control disabled')
    return
  }
  const repoRoot = await detectRepoRoot(root)
  if (!repoRoot) {
    console.error(`[git] ${root} is not inside a git repository; source control disabled`)
    return
  }

  const out = window.createOutputChannel('Git')
  context.subscriptions.push(out)
  const log = (msg: string): void => out.appendLine(msg)

  const repo = new Repository(repoRoot, log)
  context.subscriptions.push(repo)
  void repo.refresh({ fetch: true, silent: true })

  // The repository the Git Graph view currently targets. Defaults to the main
  // repo; `git-graph.setRepo` switches it to a submodule. All Git Graph queries
  // and operations below run against this root, so switching needs no per-command
  // argument changes.
  let gitGraphRoot = repoRoot

  // Run a Git Graph mutating op: report failure, refresh SCM, return ok.
  const finishOp = async (label: string, p: Promise<boolean>): Promise<boolean> => {
    const ok = await p
    if (!ok) {
      void window.showErrorMessage(`Git Graph: ${label} failed. See the Git output for details.`)
    }
    await repo.refresh()
    return ok
  }

  // Smart commit: with nothing staged, stage every change first (mirrors VSCode).
  const commitSmart = async (): Promise<boolean> => {
    const message = repo.commitMessage.trim()
    if (!message) {
      await window.showWarningMessage('Type a commit message first.')
      return false
    }
    if (!repo.hasStagedChanges) {
      if (!repo.hasChanges) {
        await window.showWarningMessage('There are no changes to commit.')
        return false
      }
      await repo.stageAll()
    }
    const ok = await repo.commit(message)
    if (ok) repo.commitMessage = ''
    return ok
  }

  context.subscriptions.push(
    commands.registerCommand('git.refresh', () => repo.refresh({ fetch: true })),

    commands.registerCommand('git.commit', () => commitSmart()),
    commands.registerCommand('git.commitAndPush', async () => {
      if (await commitSmart()) await repo.push()
    }),
    commands.registerCommand('git.commitAndSync', async () => {
      if (await commitSmart()) await repo.sync()
    }),

    commands.registerCommand('git.stage', (arg) => {
      const path = resourcePath(arg)
      return path ? repo.stage([path]) : undefined
    }),
    commands.registerCommand('git.unstage', (arg) => {
      const path = resourcePath(arg)
      return path ? repo.unstage([path]) : undefined
    }),
    commands.registerCommand('git.stageAll', () => repo.stageAll()),
    commands.registerCommand('git.unstageAll', () => repo.unstageAll()),

    commands.registerCommand('git.discard', async (arg) => {
      const path = resourcePath(arg)
      if (!path) return
      const confirm = await window.showWarningMessage(
        `Discard changes in ${repo.basename(path)}? This cannot be undone.`,
        'Discard Changes',
      )
      if (confirm !== 'Discard Changes') return
      if (isDirectoryArg(arg)) {
        await repo.discardFolder(path)
      } else {
        await repo.discard(path, resourceLetter(arg) === '?')
      }
    }),

    commands.registerCommand('git.checkout', () => repo.checkout()),
    commands.registerCommand('git.createBranch', () => repo.createBranch()),
    commands.registerCommand('git.renameBranch', () => repo.renameBranch()),
    commands.registerCommand('git.deleteBranch', () => repo.deleteBranch()),
    commands.registerCommand('git.merge', () => repo.merge()),
    commands.registerCommand('git.rebase', () => repo.rebase()),
    commands.registerCommand('git.publishBranch', () => repo.publishBranch()),

    commands.registerCommand('git.sync', () => repo.sync()),
    commands.registerCommand('git.pull', () => repo.pull()),
    commands.registerCommand('git.pullRebase', () => repo.pullRebase()),
    commands.registerCommand('git.pullAutostash', () => repo.pullAutostash()),
    commands.registerCommand('git.push', () => repo.push()),
    commands.registerCommand('git.pushForce', () => repo.pushForce()),
    commands.registerCommand('git.pushTo', () => repo.pushTo()),
    commands.registerCommand('git.fetch', () => repo.fetch()),
    commands.registerCommand('git.fetchPrune', () => repo.fetch({ prune: true })),
    commands.registerCommand('git.undoLastCommit', () => repo.undoLastCommit()),
    commands.registerCommand('git.discardAll', () => repo.discardAll()),

    commands.registerCommand('git.stash', () => repo.stashPush()),
    commands.registerCommand('git.stashIncludeUntracked', () => repo.stashPush(true)),
    commands.registerCommand('git.stashApply', () => repo.stashApply()),
    commands.registerCommand('git.stashPop', () => repo.stashApply(true)),
    commands.registerCommand('git.stashDrop', () => repo.stashDrop()),

    commands.registerCommand('git.addRemote', () => repo.addRemote()),
    commands.registerCommand('git.removeRemote', () => repo.removeRemote()),

    commands.registerCommand('git.createTag', () => repo.createTag()),
    commands.registerCommand('git.deleteTag', () => repo.deleteTag()),

    // Git Graph — read-only data source for the renderer's Git Graph editor.
    commands.registerCommand('git-graph.getRepos', () => getGitGraphRepos(repoRoot, log)),
    commands.registerCommand('git-graph.setRepo', (...args: unknown[]) => {
      const next = args[0] as string
      if (next) gitGraphRoot = next
      return true
    }),
    commands.registerCommand('git-graph.getCommits', (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as GitGraphLoadOptions
      return getGitGraphCommits(gitGraphRoot, opts, log)
    }),
    commands.registerCommand('git-graph.getCommitDetails', (...args: unknown[]) => {
      const hash = args[0] as string
      return getGitGraphCommitDetails(gitGraphRoot, hash, log)
    }),
    commands.registerCommand('git-graph.getUncommittedChanges', () =>
      getGitGraphUncommittedChanges(gitGraphRoot, log),
    ),
    commands.registerCommand('git-graph.compareCommits', (...args: unknown[]) => {
      const [from, to] = args as [string, string]
      return compareGitGraphCommits(gitGraphRoot, from, to, log)
    }),
    commands.registerCommand('git-graph.openWorkingTreeFile', (...args: unknown[]) => {
      const path = args[0] as string
      return repo.openChange(join(gitGraphRoot, path))
    }),
    commands.registerCommand('git-graph.openFileDiff', async (...args: unknown[]) => {
      const req = args[0] as GitGraphFileDiffRequest
      const content = await getGitGraphFileDiffContent(gitGraphRoot, req, log)
      await commands.executeCommand('_workbench.openDiff', {
        title: content.title,
        originalUri: pathToFileURL(content.path).href,
        original: content.original,
        modified: content.modified,
        pinned: false,
        preserveFocus: false,
      })
    }),

    // Git Graph — mutating operations targeting a right-clicked object. Each runs
    // git, surfaces failures, then refreshes the SCM view; returns ok to the
    // renderer, which reloads the graph afterwards.
    commands.registerCommand('git-graph.checkout', (...a: unknown[]) =>
      finishOp('checkout', gga.checkout(gitGraphRoot, a[0] as string, log)),
    ),
    commands.registerCommand('git-graph.cherrypick', (...a: unknown[]) =>
      finishOp('cherry-pick', gga.cherrypick(gitGraphRoot, a[0] as string, log)),
    ),
    commands.registerCommand('git-graph.revert', (...a: unknown[]) =>
      finishOp('revert', gga.revert(gitGraphRoot, a[0] as string, log)),
    ),
    commands.registerCommand('git-graph.reset', (...a: unknown[]) =>
      finishOp('reset', gga.reset(gitGraphRoot, a[0] as string, a[1] as gga.ResetMode, log)),
    ),
    commands.registerCommand('git-graph.merge', (...a: unknown[]) =>
      finishOp('merge', gga.merge(gitGraphRoot, a[0] as string, log)),
    ),
    commands.registerCommand('git-graph.rebase', (...a: unknown[]) =>
      finishOp('rebase', gga.rebase(gitGraphRoot, a[0] as string, log)),
    ),
    commands.registerCommand('git-graph.createBranch', (...a: unknown[]) =>
      finishOp(
        'create branch',
        gga.createBranch(gitGraphRoot, a[0] as string, a[1] as string, a[2] !== false, log),
      ),
    ),
    commands.registerCommand('git-graph.renameBranch', (...a: unknown[]) =>
      finishOp(
        'rename branch',
        gga.renameBranch(gitGraphRoot, a[0] as string, a[1] as string, log),
      ),
    ),
    commands.registerCommand('git-graph.deleteBranch', (...a: unknown[]) =>
      finishOp('delete branch', gga.deleteBranch(gitGraphRoot, a[0] as string, a[1] === true, log)),
    ),
    commands.registerCommand('git-graph.pushBranch', (...a: unknown[]) =>
      finishOp(
        'push branch',
        gga.pushBranch(gitGraphRoot, a[0] as string, (a[1] as string) || 'origin', log),
      ),
    ),
    commands.registerCommand('git-graph.checkoutRemote', (...a: unknown[]) =>
      finishOp('checkout', gga.checkoutRemote(gitGraphRoot, a[0] as string, a[1] as string, log)),
    ),
    commands.registerCommand('git-graph.createTag', (...a: unknown[]) =>
      finishOp(
        'create tag',
        gga.createTag(
          gitGraphRoot,
          a[0] as string,
          a[1] as string,
          a[2] as string | undefined,
          log,
        ),
      ),
    ),
    commands.registerCommand('git-graph.deleteTag', (...a: unknown[]) =>
      finishOp('delete tag', gga.deleteTag(gitGraphRoot, a[0] as string, log)),
    ),
    commands.registerCommand('git-graph.pushTag', (...a: unknown[]) =>
      finishOp(
        'push tag',
        gga.pushTag(gitGraphRoot, a[0] as string, (a[1] as string) || 'origin', log),
      ),
    ),
    commands.registerCommand('git-graph.stashApply', (...a: unknown[]) =>
      finishOp('stash apply', gga.stashApply(gitGraphRoot, a[0] as string, log)),
    ),
    commands.registerCommand('git-graph.stashPop', (...a: unknown[]) =>
      finishOp('stash pop', gga.stashPop(gitGraphRoot, a[0] as string, log)),
    ),
    commands.registerCommand('git-graph.stashDrop', (...a: unknown[]) =>
      finishOp('stash drop', gga.stashDrop(gitGraphRoot, a[0] as string, log)),
    ),

    commands.registerCommand('git.openChange', (...args: unknown[]) => {
      const [arg, options] = args as [
        unknown,
        ({ pinned?: boolean; preserveFocus?: boolean } | undefined)?,
      ]
      const path = resourcePath(arg)
      return path
        ? repo.openChange(path, options?.pinned ?? false, options?.preserveFocus ?? false)
        : undefined
    }),
  )
}

export function deactivate(): void {
  // Disposables on context.subscriptions (repository, watcher, commands) handle teardown.
}
