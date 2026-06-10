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
import { RepositoryManager } from './repositoryManager.js'
import { discoverRepos } from './repoDiscovery.js'
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
import { getBlame } from './blameSource.js'

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

  // Surface the main repo plus every initialized submodule as its own SCM
  // provider. Only the main repo owns the branch / sync status-bar items.
  const mgr = new RepositoryManager(repoRoot, log)
  context.subscriptions.push(mgr)
  const discovered = await discoverRepos(repoRoot, log)
  for (const { root, name, initialized } of discovered) {
    const isMain = root === repoRoot
    if (!isMain && !initialized) continue
    mgr.add(root, { statusBar: isMain, label: isMain ? 'Git' : `Git: ${name}` })
  }
  for (const repo of mgr.all) void repo.refresh({ fetch: true, silent: true })

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
    await mgr.resolveRepo({ rootUri: gitGraphRoot })?.refresh()
    return ok
  }

  // Smart commit: with nothing staged, stage every change first (mirrors VSCode).
  const commitSmart = async (repo: Repository | undefined): Promise<boolean> => {
    if (!repo) return false
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
    commands.registerCommand('git.refresh', (arg) =>
      mgr.resolveRepo(arg)?.refresh({ fetch: true }),
    ),

    commands.registerCommand('git.commit', (arg) => commitSmart(mgr.resolveRepo(arg))),
    commands.registerCommand('git.commitAndPush', async (arg) => {
      const repo = mgr.resolveRepo(arg)
      if (await commitSmart(repo)) await repo?.push()
    }),
    commands.registerCommand('git.commitAndSync', async (arg) => {
      const repo = mgr.resolveRepo(arg)
      if (await commitSmart(repo)) await repo?.sync()
    }),

    commands.registerCommand('git.stage', (arg) => {
      const path = resourcePath(arg)
      return path ? mgr.resolveRepo(arg)?.stage([path]) : undefined
    }),
    commands.registerCommand('git.unstage', (arg) => {
      const path = resourcePath(arg)
      return path ? mgr.resolveRepo(arg)?.unstage([path]) : undefined
    }),
    commands.registerCommand('git.stageAll', (arg) => mgr.resolveRepo(arg)?.stageAll()),
    commands.registerCommand('git.unstageAll', (arg) => mgr.resolveRepo(arg)?.unstageAll()),

    commands.registerCommand('git.discard', async (arg) => {
      const repo = mgr.resolveRepo(arg)
      const path = resourcePath(arg)
      if (!repo || !path) return
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

    commands.registerCommand('git.checkout', (arg) => mgr.resolveRepo(arg)?.checkout()),
    commands.registerCommand('git.createBranch', (arg) => mgr.resolveRepo(arg)?.createBranch()),
    commands.registerCommand('git.renameBranch', (arg) => mgr.resolveRepo(arg)?.renameBranch()),
    commands.registerCommand('git.deleteBranch', (arg) => mgr.resolveRepo(arg)?.deleteBranch()),
    commands.registerCommand('git.merge', (arg) => mgr.resolveRepo(arg)?.merge()),
    commands.registerCommand('git.rebase', (arg) => mgr.resolveRepo(arg)?.rebase()),
    commands.registerCommand('git.publishBranch', (arg) => mgr.resolveRepo(arg)?.publishBranch()),

    commands.registerCommand('git.sync', (arg) => mgr.resolveRepo(arg)?.sync()),
    commands.registerCommand('git.pull', (arg) => mgr.resolveRepo(arg)?.pull()),
    commands.registerCommand('git.pullRebase', (arg) => mgr.resolveRepo(arg)?.pullRebase()),
    commands.registerCommand('git.pullAutostash', (arg) => mgr.resolveRepo(arg)?.pullAutostash()),
    commands.registerCommand('git.push', (arg) => mgr.resolveRepo(arg)?.push()),
    commands.registerCommand('git.pushForce', (arg) => mgr.resolveRepo(arg)?.pushForce()),
    commands.registerCommand('git.pushTo', (arg) => mgr.resolveRepo(arg)?.pushTo()),
    commands.registerCommand('git.fetch', (arg) => mgr.resolveRepo(arg)?.fetch()),
    commands.registerCommand('git.fetchPrune', (arg) =>
      mgr.resolveRepo(arg)?.fetch({ prune: true }),
    ),
    commands.registerCommand('git.undoLastCommit', (arg) => mgr.resolveRepo(arg)?.undoLastCommit()),
    commands.registerCommand('git.discardAll', (arg) => mgr.resolveRepo(arg)?.discardAll()),

    commands.registerCommand('git.stash', (arg) => mgr.resolveRepo(arg)?.stashPush()),
    commands.registerCommand('git.stashIncludeUntracked', (arg) =>
      mgr.resolveRepo(arg)?.stashPush(true),
    ),
    commands.registerCommand('git.stashApply', (arg) => mgr.resolveRepo(arg)?.stashApply()),
    commands.registerCommand('git.stashPop', (arg) => mgr.resolveRepo(arg)?.stashApply(true)),
    commands.registerCommand('git.stashDrop', (arg) => mgr.resolveRepo(arg)?.stashDrop()),

    commands.registerCommand('git.addRemote', (arg) => mgr.resolveRepo(arg)?.addRemote()),
    commands.registerCommand('git.removeRemote', (arg) => mgr.resolveRepo(arg)?.removeRemote()),

    commands.registerCommand('git.createTag', (arg) => mgr.resolveRepo(arg)?.createTag()),
    commands.registerCommand('git.deleteTag', (arg) => mgr.resolveRepo(arg)?.deleteTag()),

    commands.registerCommand('git.submoduleUpdateInit', () => mgr.main?.submoduleUpdateInit()),
    commands.registerCommand('git.submoduleSync', () => mgr.main?.submoduleSync()),

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
      return mgr.resolveRepo({ rootUri: gitGraphRoot })?.openChange(join(gitGraphRoot, path))
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
        gga.pushBranch(
          gitGraphRoot,
          a[0] as string,
          (a[1] as string) || 'origin',
          a[2] === true,
          log,
        ),
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

    commands.registerCommand('git.getBlame', (...args: unknown[]) => {
      const path = args[0] as string
      const ignoreWhitespace = args[1] === true
      const repo = mgr.resolveRepo({ resourceUri: path })
      if (!repo || !path) return null
      return getBlame(repo.root, path, { ignoreWhitespace }, log)
    }),

    commands.registerCommand('git.getHeadContent', (...args: unknown[]) => {
      const path = args[0] as string
      const repo = mgr.resolveRepo({ resourceUri: path })
      if (!repo || !path) return null
      return repo.getHeadContent(path)
    }),

    commands.registerCommand('git.openChange', async (...args: unknown[]) => {
      const [arg, options] = args as [
        unknown,
        ({ pinned?: boolean; preserveFocus?: boolean } | undefined)?,
      ]
      let path = resourcePath(arg)
      let repoArg: unknown = arg
      // Invoked without a SCM resource (keybinding / toolbar): fall back to the
      // active editor's file, which the host surfaces via this internal command.
      if (!path) {
        path = await commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile')
        repoArg = path ? { resourceUri: path } : undefined
      }
      return path
        ? mgr
            .resolveRepo(repoArg)
            ?.openChange(path, options?.pinned ?? false, options?.preserveFocus ?? false)
        : undefined
    }),

    commands.registerCommand('git.openFile', async (...args: unknown[]) => {
      const path =
        resourcePath(args[0]) ??
        (await commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile'))
      if (path) await commands.executeCommand('_workbench.openFile', path)
    }),
  )
}

export function deactivate(): void {
  // Disposables on context.subscriptions (repository, watcher, commands) handle teardown.
}
