/**
 * Git extension entry. Detects the repository containing the open workspace
 * folder, surfaces it through the SCM API (staged / working-tree groups driven
 * by real `git status` output), and wires the stage/unstage/commit/refresh/
 * checkout commands to the `git` CLI. A filesystem watcher keeps the view live.
 *
 * Repositories may also appear after activation (`git init` / `git clone` in an
 * already-open folder): mirroring VSCode's `onPossibleGitRepositoryChange`, a
 * workspace-wide watcher reacts to any `.git` entry showing up — running the
 * full setup when no repo was known at startup, or adding the late repo to the
 * existing manager otherwise. No window reload needed.
 *
 * `activate` runs inside the extension host process; the host injects the API
 * and the open folder via `workspace.rootPath`. Everything is registered on
 * `context.subscriptions` so it is torn down on deactivate.
 */
import {
  commands,
  workspace,
  window,
  type Disposable,
  type ExtensionContext,
} from '@universe-editor/extension-api'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RepositoryManager } from './repositoryManager.js'
import { GitStatusBarController } from './gitStatusBar.js'
import { commitAmendSmart, commitSmart } from './commitOperations.js'
import {
  discoverRepos,
  type DiscoverOptions,
  type DiscoverResult,
  type DiscoveredRepo,
} from './repoDiscovery.js'
import { PossibleRepoWatcher, joinCandidate } from './possibleRepoWatcher.js'
import { detectRepoRoot } from './gitService.js'
import { norm } from './pathUtil.js'
import type { Repository } from './repository.js'
import {
  getCommits as getGitGraphCommits,
  getCommitDetails as getGitGraphCommitDetails,
  getRepos as getGitGraphRepos,
  getBranches as getGitGraphBranches,
  compareCommits as compareGitGraphCommits,
  getFileDiffContent as getGitGraphFileDiffContent,
  buildCommitChangesPayload,
  revealPathForFile,
  type GitGraphLoadOptions,
  type GitGraphFileDiffRequest,
} from './gitGraphSource.js'
import * as gga from './gitGraphActions.js'
import { updateSubmodulesIfPresent } from './submoduleSync.js'
import { autoSyncWorktreesAfterPull } from './worktreeAutoSync.js'
import { getBlame } from './blameSource.js'
import { createGitTimelineCommands, GitTimelineProvider } from './timelineProvider.js'
import { notifyGitFailure, setGitLogShower } from './gitError.js'
import { localize } from './nls.js'

function resourcePath(arg: unknown): string | undefined {
  return (arg as { resourceUri?: string } | undefined)?.resourceUri
}

function resourceLetter(arg: unknown): string | undefined {
  return (arg as { contextValue?: string } | undefined)?.contextValue
}

function isDirectoryArg(arg: unknown): boolean {
  return (arg as { isDirectory?: boolean } | undefined)?.isDirectory === true
}

/**
 * Callers hand a repo file as an extension Uri object, a `file:` URI string, or
 * a raw fsPath; resolveRepo wants a plain filesystem path. Anything
 * unrecognizable comes back undefined so the caller falls back to the graph's
 * current repo.
 */
export function normalizeUriArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    // Drive letters (`c:\...`) match a URI scheme pattern but are plain fsPaths.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(arg) && !/^[a-zA-Z]:[\\/]/.test(arg)) {
      if (!arg.startsWith('file:')) return undefined
      try {
        return fileURLToPath(arg)
      } catch {
        return undefined
      }
    }
    return arg
  }
  if (typeof arg !== 'object' || arg === null) return undefined
  const uri = arg as { fsPath?: unknown; scheme?: unknown; path?: unknown }
  // A remote scheme would fold its authority into `fsPath` and poison the git
  // CLI, which only ever sees this host's filesystem. No local path to resolve.
  if (uri.scheme !== undefined && uri.scheme !== 'file') return undefined
  if (typeof uri.fsPath === 'string') return uri.fsPath
  if (typeof uri.path === 'string') {
    try {
      return fileURLToPath(`file://${uri.path}`)
    } catch {
      return undefined
    }
  }
  return undefined
}

async function readScanConfig(): Promise<DiscoverOptions> {
  const cfg = workspace.getConfiguration('git')
  const auto = await cfg.get('autoRepositoryDetection', true)
  const maxDepth = auto ? await cfg.get('repositoryScanMaxDepth', 3) : 0
  const ignoredFolders = await cfg.get('repositoryScanIgnoredFolders', ['node_modules'])
  return { maxDepth, ignoredFolders }
}

/**
 * When the workspace folder itself isn't a repo there's no natural "main", so
 * pick the discovered repo whose normalized root sorts first — deterministic and
 * stable across launches, so the status-bar owner doesn't jump around.
 */
export function pickStatusBarRoot(repos: readonly DiscoveredRepo[]): string {
  return [...repos].sort((a, b) => norm(a.root).localeCompare(norm(b.root)))[0]!.root
}

// With no git repo the real commands never register, but a restored Git Graph
// tab still queries them. Stubs answer "no repos / unavailable" so the view
// settles instead of spinning on unregistered commands.
function registerGitGraphStubs(): Disposable[] {
  return [
    commands.registerCommand('git-graph.getRepos', () => []),
    commands.registerCommand('git-graph.getCommits', () => null),
    commands.registerCommand('git-graph.setRepo', () => undefined),
  ]
}

export interface GitEnv {
  /** Workspace folder path. */
  readonly root: string
  readonly scanOpts: DiscoverOptions
  readonly log: (msg: string) => void
}

/**
 * Build everything a discovered repo set needs: the RepositoryManager + SCM
 * providers, the shared status-bar pair, the timeline provider, and the full
 * command surface. Runs either at activation (repos found by the initial scan)
 * or later, when the workspace watcher sees the first `.git` appear.
 */
function setupRepositories(
  context: ExtensionContext,
  env: GitEnv,
  found: DiscoverResult,
): RepositoryManager {
  const { log } = env
  // The status-bar owner is the workspace-root repo when there is one; otherwise
  // a deterministically chosen repo. Only it owns the branch / sync status-bar
  // items, and the Git Graph view defaults to it.
  const statusBarRoot = found.mainRoot ?? pickStatusBarRoot(found.repos)

  // Surface every discovered (initialized) repo as its own SCM provider.
  const mgr = new RepositoryManager(statusBarRoot, log)
  context.subscriptions.push(mgr)

  // One shared status-bar pair renders whichever repo is active.
  const statusBar = new GitStatusBarController(mgr)
  context.subscriptions.push(statusBar)

  // The repository the Git Graph view currently targets. Defaults to the
  // status-bar repo; `git-graph.setRepo` switches it to another discovered repo.
  // Boxed so the command closures below share the mutable reference.
  const graph = { current: statusBarRoot }

  // Timeline — file-history entries for the Explorer Timeline view. One provider
  // serves every discovered repo; each repo refresh invalidates the view's pages.
  // Late-added repos (workspace watcher) attach through the same onDidAdd hook.
  const timelineProvider = new GitTimelineProvider(mgr, log)
  context.subscriptions.push(
    mgr.onDidAdd((repo) => {
      context.subscriptions.push(timelineProvider.trackRepo(repo))
      statusBar.refresh()
    }),
  )
  context.subscriptions.push(workspace.registerTimelineProvider(['file'], timelineProvider))
  context.subscriptions.push(...createGitTimelineCommands(mgr, graph, log))

  for (const { root: repoRoot, name, initialized } of found.repos) {
    const isMain = norm(repoRoot) === norm(statusBarRoot)
    if (!isMain && !initialized) continue
    mgr.add(repoRoot, { label: isMain ? 'Git' : `Git: ${name}` })
  }
  statusBar.refresh()
  for (const repo of mgr.all) void repo.refresh({ fetch: true, silent: true })

  registerGitCommands(context, env, mgr, graph, statusBar)
  return mgr
}

/** Box holding the repo the Git Graph view currently targets; command closures
 *  share the mutable reference so `git-graph.setRepo` re-points them all. */
export interface GitGraphTarget {
  current: string
}

/** The whole git command surface, routed through `mgr` and the Git Graph target box. */
function registerGitCommands(
  context: ExtensionContext,
  env: GitEnv,
  mgr: RepositoryManager,
  graph: GitGraphTarget,
  statusBar: GitStatusBarController,
): Map<string, (...args: unknown[]) => unknown> {
  const { root, scanOpts, log } = env
  const registry = new Map<string, (...args: unknown[]) => unknown>()
  const register = (id: string, handler: (...args: unknown[]) => unknown): Disposable => {
    registry.set(id, handler)
    return commands.registerCommand(id, handler)
  }

  // Bring submodules to the commit a graph operation just moved HEAD to, then
  // refresh the SCM views of the submodule repos it moved behind their back.
  const syncSubmodulesForGraphOp = async (root: string): Promise<void> => {
    const enabled = await workspace.getConfiguration('git').get('autoUpdateSubmodules', true)
    if (!enabled) {
      log?.('[git] skip submodule update: git.autoUpdateSubmodules is disabled')
      return
    }
    const outcome = await updateSubmodulesIfPresent(root, log)
    if (!outcome.ran) return
    if (outcome.result.exitCode !== 0) {
      await notifyGitFailure('submodule update', outcome.result)
      return
    }
    for (const sub of mgr.submodulesOf(root)) void sub.refresh()
  }

  // Run a Git Graph mutating op: report failure (with the real git error), tell
  // the user when it landed in another worktree, update submodules when the op
  // moved the working tree, refresh SCM, return ok.
  const finishOp = async (
    label: string,
    p: Promise<gga.GraphMutationResult>,
    opts?: { readonly submoduleUpdate?: boolean },
  ): Promise<boolean> => {
    const res = await p
    const ok = res.exitCode === 0
    if (!ok) {
      await notifyGitFailure(`Graph: ${label}`, res)
    } else {
      if (res.worktreeName !== undefined) {
        void window.showInformationMessage(
          localize('git.graph.opDoneInWorktree', "Done in worktree '{0}'.", {
            0: res.worktreeName,
          }),
        )
      }
      // Submodules must be updated where HEAD actually moved: an op redirected
      // into another worktree changed that tree's gitlinks, not graph.current's.
      if (opts?.submoduleUpdate) await syncSubmodulesForGraphOp(res.worktreePath ?? graph.current)
    }
    await mgr.resolveRepo({ rootUri: graph.current })?.refresh()
    return ok
  }

  context.subscriptions.push(
    // Point argument-less commands (command palette, keybindings, status bar) at
    // the repo the SCM view currently shows. Pushed by the renderer on selection.
    register('git.setActiveRepo', (...args: unknown[]) => {
      // `== null` on purpose: the renderer→host forwarding crosses a nested args
      // array, where a sandwiched undefined arrives as null (documented platform
      // convention, proxyChannel.ts) — null must mean "no selection" like undefined.
      const root = args[0] as string | null | undefined
      // null/undefined — or a root this extension doesn't own (the selection is
      // a p4 client in a mixed workspace) — hides the status-bar pair.
      if (root == null || !mgr.has(root)) {
        statusBar.setVisible(false)
        return
      }
      // setActive before setVisible: setVisible(true) re-renders, so the new
      // active repo must already be in place or it would paint the old one first.
      mgr.setActive(root)
      statusBar.setVisible(true)
    }),

    register('git.refresh', (arg) => mgr.resolveRepo(arg)?.refresh({ fetch: true })),

    register('git.commit', (arg) => commitSmart(mgr.resolveRepo(arg))),
    register('git.commitAmend', (arg) => commitAmendSmart(mgr.resolveRepo(arg))),
    register('git.commitAndPush', async (arg) => {
      const repo = mgr.resolveRepo(arg)
      if (await commitSmart(repo)) await repo?.push()
    }),
    register('git.commitAndSync', async (arg) => {
      const repo = mgr.resolveRepo(arg)
      if (await commitSmart(repo)) await repo?.sync()
    }),

    register('git.stage', (arg) => {
      const path = resourcePath(arg)
      return path ? mgr.resolveRepo(arg)?.stage([path]) : undefined
    }),
    register('git.unstage', (arg) => {
      const path = resourcePath(arg)
      return path ? mgr.resolveRepo(arg)?.unstage([path]) : undefined
    }),
    register('git.stageAll', (arg) => mgr.resolveRepo(arg)?.stageAll()),
    register('git.unstageAll', (arg) => mgr.resolveRepo(arg)?.unstageAll()),

    register('git.discard', async (arg) => {
      const repo = mgr.resolveRepo(arg)
      const path = resourcePath(arg)
      if (!repo || !path) return
      const BTN_DISCARD = localize('git.btn.discardChanges', 'Discard Changes')
      const confirm = await window.showWarningMessage(
        localize('git.discard.fileConfirm', "Discard changes in '{0}'? This cannot be undone.", {
          0: repo.basename(path),
        }),
        BTN_DISCARD,
      )
      if (confirm !== BTN_DISCARD) return
      if (isDirectoryArg(arg)) {
        await repo.discardFolder(path)
      } else {
        await repo.discard(path, resourceLetter(arg) === '?')
      }
    }),

    register('git.checkout', (arg) => mgr.resolveRepo(arg)?.checkout()),
    register('git.createBranch', (arg) => mgr.resolveRepo(arg)?.createBranch()),
    register('git.renameBranch', (arg) => mgr.resolveRepo(arg)?.renameBranch()),
    register('git.deleteBranch', (arg) => mgr.resolveRepo(arg)?.deleteBranch()),
    register('git.merge', (arg) => mgr.resolveRepo(arg)?.merge()),
    register('git.rebase', (arg) => mgr.resolveRepo(arg)?.rebase()),
    register('git.publishBranch', (arg) => mgr.resolveRepo(arg)?.publishBranch()),

    register('git.createWorktree', (arg) => mgr.resolveRepo(arg)?.createWorktree()),
    register('git.openWorktree', (arg) => mgr.resolveRepo(arg)?.openWorktree(false)),
    register('git.openWorktreeInNewWindow', (arg) => mgr.resolveRepo(arg)?.openWorktree(true)),
    register('git.deleteWorktree', (arg) => mgr.resolveRepo(arg)?.deleteWorktree()),

    register('git.sync', (arg) => mgr.resolveRepo(arg)?.sync()),
    register('git.pull', (arg) => mgr.resolveRepo(arg)?.pull()),
    register('git.pullRebase', (arg) => mgr.resolveRepo(arg)?.pullRebase()),
    register('git.pullAutostash', (arg) => mgr.resolveRepo(arg)?.pullAutostash()),
    register('git.push', (arg) => mgr.resolveRepo(arg)?.push()),
    register('git.pushForce', (arg) => mgr.resolveRepo(arg)?.pushForce()),
    register('git.pushTo', (arg) => mgr.resolveRepo(arg)?.pushTo()),
    register('git.fetch', (arg) => mgr.resolveRepo(arg)?.fetch()),
    register('git.fetchPrune', (arg) => mgr.resolveRepo(arg)?.fetch({ prune: true })),
    register('git.undoLastCommit', (arg) => mgr.resolveRepo(arg)?.undoLastCommit()),
    register('git.discardAll', (arg) => mgr.resolveRepo(arg)?.discardAll()),

    register('git.stash', (arg) => mgr.resolveRepo(arg)?.stashPush()),
    register('git.stashIncludeUntracked', (arg) => mgr.resolveRepo(arg)?.stashPush(true)),
    register('git.stashApply', (arg) => mgr.resolveRepo(arg)?.stashApply()),
    register('git.stashPop', (arg) => mgr.resolveRepo(arg)?.stashApply(true)),
    register('git.stashDrop', (arg) => mgr.resolveRepo(arg)?.stashDrop()),

    register('git.addRemote', (arg) => mgr.resolveRepo(arg)?.addRemote()),
    register('git.removeRemote', (arg) => mgr.resolveRepo(arg)?.removeRemote()),

    register('git.createTag', (arg) => mgr.resolveRepo(arg)?.createTag()),
    register('git.deleteTag', (arg) => mgr.resolveRepo(arg)?.deleteTag()),

    register('git.submoduleUpdateInit', (arg) => mgr.resolveRepo(arg)?.submoduleUpdateInit()),
    register('git.submoduleSync', (arg) => mgr.resolveRepo(arg)?.submoduleSync()),

    // Git Graph — read-only data source for the renderer's Git Graph editor.
    register('git-graph.getRepos', async () => {
      const list = await getGitGraphRepos(root, scanOpts, log)
      // Surface the current graph root first so the renderer can treat repos[0]
      // as "the default repo" — it skips a redundant reload when the SCM view
      // selects that same default on first open.
      return [...list].sort((a, b) =>
        norm(a.root) === norm(graph.current) ? -1 : norm(b.root) === norm(graph.current) ? 1 : 0,
      )
    }),
    register('git-graph.setRepo', (...args: unknown[]) => {
      const next = args[0] as string
      if (next) graph.current = next
      return true
    }),
    register('git-graph.getCommits', (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as GitGraphLoadOptions
      return getGitGraphCommits(graph.current, { ...opts, workspaceRoot: root }, log)
    }),
    register('git-graph.getCommitDetails', (...args: unknown[]) => {
      const hash = args[0] as string
      return getGitGraphCommitDetails(graph.current, hash, log)
    }),
    register('git-graph.compareCommits', (...args: unknown[]) => {
      const [from, to] = args as [string, string]
      return compareGitGraphCommits(graph.current, from, to, log)
    }),
    register('git-graph.getBranches', () => getGitGraphBranches(graph.current, log)),
    register('git-graph.openWorkingTreeFile', (...args: unknown[]) => {
      const path = args[0] as string
      return mgr.resolveRepo({ rootUri: graph.current })?.openChange(join(graph.current, path))
    }),
    register('git-graph.openFileDiff', async (...args: unknown[]) => {
      const req = args[0] as GitGraphFileDiffRequest
      const options = args[1] as { preserveFocus?: boolean } | undefined
      const content = await getGitGraphFileDiffContent(req.root ?? graph.current, req, log)
      await commands.executeCommand('_workbench.openDiff', {
        title: content.title,
        originalUri: pathToFileURL(content.path).href,
        original: content.original,
        modified: content.modified,
        pinned: false,
        preserveFocus: options?.preserveFocus ?? false,
        openableUri: pathToFileURL(content.path).href,
      })
    }),
    register('git.viewCommit', async (...args: unknown[]) => {
      const [uriArg, hash, revealUri] = args as [unknown, string | undefined, unknown]
      if (typeof hash !== 'string' || !hash) {
        log(`[git] git.viewCommit ignored: missing hash`)
        return
      }
      const root = mgr.resolveRepo({ resourceUri: normalizeUriArg(uriArg) })?.root ?? graph.current
      const payload = await buildCommitChangesPayload(root, hash, log)
      if (!payload) return
      // Scroll the opened view to the caller's file: the reveal uri wins
      // (VSCode's history-view convention), else the first argument is often
      // the blamed/timeline file itself.
      const revealPath = revealPathForFile(payload, revealUri ?? uriArg)
      log(`[git] git.viewCommit: ${hash} in ${root} (${payload.files.length} files)`)
      await commands.executeCommand('_workbench.showCommitChanges', {
        ...payload,
        ...(revealPath !== undefined ? { revealPath } : {}),
      })
    }),

    register('git-graph.openWorktree', async (...args: unknown[]) => {
      const [path, newWindow] = args as [string, boolean]
      if (!path) return
      await commands.executeCommand(
        newWindow ? '_workbench.openFolderInNewWindow' : '_workbench.openFolder',
        path,
      )
    }),
    register('git-graph.deleteWorktree', async (...args: unknown[]) => {
      const path = args[0] as string
      if (!path) return
      await mgr.resolveRepo({ rootUri: graph.current })?.removeWorktreeAt(path, basename(path))
    }),
    register('git-graph.syncWorktrees', async (...args: unknown[]) => {
      const [targetBranch, worktrees, force] = args as [string, gga.SyncWorktreeRef[], boolean?]
      const result = await gga.syncWorktreesToBranch(
        targetBranch,
        worktrees ?? [],
        log,
        force === true,
      )
      await mgr.resolveRepo({ rootUri: graph.current })?.refresh()
      return result
    }),

    // Git Graph — mutating operations targeting a right-clicked object. Each runs
    // git, surfaces failures, then refreshes the SCM view; returns ok to the
    // renderer, which reloads the graph afterwards.
    register('git-graph.checkout', (...a: unknown[]) =>
      finishOp('checkout', gga.checkout(graph.current, a[0] as string, log), {
        submoduleUpdate: true,
      }),
    ),
    register('git-graph.cherrypick', (...a: unknown[]) =>
      finishOp('cherry-pick', gga.cherrypick(graph.current, a[0] as string, log), {
        submoduleUpdate: true,
      }),
    ),
    register('git-graph.cherryPickToBranch', (...a: unknown[]) =>
      finishOp(
        'cherry-pick to branch',
        gga.cherryPickToBranch(graph.current, a[0] as string, a[1] as string, log),
        { submoduleUpdate: true },
      ),
    ),
    register('git-graph.revert', (...a: unknown[]) =>
      finishOp('revert', gga.revert(graph.current, a[0] as string, log), {
        submoduleUpdate: true,
      }),
    ),
    // Only `--hard` refreshes the working tree; after soft/mixed the superproject's
    // tree still holds the old gitlinks, so updating submodules would desync them.
    register('git-graph.reset', (...a: unknown[]) =>
      finishOp('reset', gga.reset(graph.current, a[0] as string, a[1] as gga.ResetMode, log), {
        submoduleUpdate: a[1] === 'hard',
      }),
    ),
    register('git-graph.merge', (...a: unknown[]) =>
      finishOp('merge', gga.merge(graph.current, a[0] as string, log), { submoduleUpdate: true }),
    ),
    register('git-graph.rebase', (...a: unknown[]) =>
      finishOp('rebase', gga.rebase(graph.current, a[0] as string, log), {
        submoduleUpdate: true,
      }),
    ),
    register('git-graph.createBranch', (...a: unknown[]) =>
      finishOp(
        'create branch',
        gga.createBranch(graph.current, a[0] as string, a[1] as string, a[2] !== false, log),
        { submoduleUpdate: a[2] !== false },
      ),
    ),
    register('git-graph.renameBranch', (...a: unknown[]) =>
      finishOp(
        'rename branch',
        gga.renameBranch(graph.current, a[0] as string, a[1] as string, log),
      ),
    ),
    register('git-graph.deleteBranch', (...a: unknown[]) =>
      finishOp(
        'delete branch',
        gga.deleteBranch(graph.current, a[0] as string, a[1] === true, log),
      ),
    ),
    register('git-graph.pushBranch', (...a: unknown[]) =>
      finishOp(
        'push branch',
        gga.pushBranch(
          graph.current,
          a[0] as string,
          (a[1] as string) || 'origin',
          a[2] === true,
          log,
        ),
      ),
    ),
    register('git-graph.pull', async (...a: unknown[]) => {
      const branch = a[0] as string
      const ok = await finishOp(
        'pull',
        gga.pullBranch(graph.current, branch, a[1] as gga.PullMode, log),
        { submoduleUpdate: true },
      )
      // HEAD is back on the original branch after a cross-branch pull, so the
      // pulled branch's ref — not HEAD — points at the new commit to sync to.
      if (ok) await autoSyncWorktreesAfterPull(graph.current, branch, log)
      return ok
    }),
    register('git-graph.checkoutRemote', (...a: unknown[]) =>
      finishOp('checkout', gga.checkoutRemote(graph.current, a[0] as string, a[1] as string, log), {
        submoduleUpdate: true,
      }),
    ),
    register('git-graph.resetBranchToRemote', (...a: unknown[]) =>
      finishOp(
        'reset branch',
        gga.resetBranchToRemote(graph.current, a[0] as string, a[1] as string, log),
        { submoduleUpdate: true },
      ),
    ),
    register('git-graph.deleteRemoteBranch', (...a: unknown[]) => {
      const name = a[0] as string
      const slashIdx = name.indexOf('/')
      if (slashIdx === -1) return false
      const remote = name.slice(0, slashIdx)
      const branch = name.slice(slashIdx + 1)
      return finishOp(
        'delete remote branch',
        gga.deleteRemoteBranch(graph.current, remote, branch, log),
      )
    }),
    register('git-graph.createTag', (...a: unknown[]) =>
      finishOp(
        'create tag',
        gga.createTag(
          graph.current,
          a[0] as string,
          a[1] as string,
          a[2] as string | undefined,
          log,
        ),
      ),
    ),
    register('git-graph.deleteTag', (...a: unknown[]) =>
      finishOp('delete tag', gga.deleteTag(graph.current, a[0] as string, log)),
    ),
    register('git-graph.pushTag', (...a: unknown[]) =>
      finishOp(
        'push tag',
        gga.pushTag(graph.current, a[0] as string, (a[1] as string) || 'origin', log),
      ),
    ),
    register('git-graph.stashApply', (...a: unknown[]) =>
      finishOp('stash apply', gga.stashApply(graph.current, a[0] as string, log), {
        submoduleUpdate: true,
      }),
    ),
    register('git-graph.stashPop', (...a: unknown[]) =>
      finishOp('stash pop', gga.stashPop(graph.current, a[0] as string, log), {
        submoduleUpdate: true,
      }),
    ),
    register('git-graph.stashDrop', (...a: unknown[]) =>
      finishOp('stash drop', gga.stashDrop(graph.current, a[0] as string, log)),
    ),

    register('git.getBlame', (...args: unknown[]) => {
      const path = args[0] as string
      const ignoreWhitespace = args[1] === true
      const repo = mgr.resolveRepo({ resourceUri: path })
      if (!repo || !path) return null
      return getBlame(repo.root, path, { ignoreWhitespace }, log)
    }),

    register('git.getCommitDiff', (arg) => mgr.resolveRepo(arg)?.getCommitDiff()),
    register('git.getCommitGenerationContext', (arg) =>
      mgr.resolveRepo(arg)?.getCommitGenerationContext(),
    ),
    register('git.setCommitMessage', (...args: unknown[]) => {
      const [arg, message] = args as [unknown, string]
      const repo = mgr.resolveRepo(arg)
      if (repo) repo.commitMessage = message
    }),

    register('git.getHeadContent', (...args: unknown[]) => {
      const path = args[0] as string
      const repo = mgr.resolveRepo({ resourceUri: path })
      if (!repo || !path) return null
      return repo.getHeadContent(path)
    }),

    register('git.checkIgnore', async (...args: unknown[]) => {
      const paths = Array.isArray(args[0]) ? (args[0] as string[]) : []
      const byRepo = new Map<Repository, string[]>()
      for (const path of paths) {
        // Paths outside every repo report as not ignored (never filtered).
        const repo = mgr.resolveRepo({ resourceUri: path })
        if (!repo) continue
        const list = byRepo.get(repo)
        if (list) list.push(path)
        else byRepo.set(repo, [path])
      }
      const ignored: string[] = []
      for (const [repo, repoPaths] of byRepo) {
        ignored.push(...(await repo.checkIgnore(repoPaths)))
      }
      return ignored
    }),

    register('git.stageChange', (...args: unknown[]) => {
      const [path, startLine, endLine] = args as [string, number, number]
      const repo = mgr.resolveRepo({ resourceUri: path })
      if (!repo || !path) return false
      return repo.stageChange(path, startLine, endLine)
    }),

    register('git.openChange', async (...args: unknown[]) => {
      const [arg, options] = args as [
        unknown,
        ({ pinned?: boolean; preserveFocus?: boolean } | undefined)?,
      ]
      const path = resourcePath(arg)
      if (!path) return
      return mgr
        .resolveRepo(arg)
        ?.openChange(path, options?.pinned ?? false, options?.preserveFocus ?? false)
    }),

    register('git.openMergeEditor', async (...args: unknown[]) => {
      const path = resourcePath(args[0])
      if (!path) return
      await mgr.resolveRepo({ resourceUri: path })?.openMergeEditor(path)
    }),

    register('git.openFile', async (...args: unknown[]) => {
      const path =
        resourcePath(args[0]) ??
        (await commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile'))
      if (path) await commands.executeCommand('_workbench.openFile', path)
    }),
  )
  return registry
}

/** Test seam: the git command surface without `activate`'s discovery/watcher. */
export function createGitCommandsForTest(
  mgr: RepositoryManager,
  graph: GitGraphTarget,
  env: GitEnv,
  statusBar: GitStatusBarController = {} as GitStatusBarController,
): Map<string, (...args: unknown[]) => unknown> {
  const context = { subscriptions: [] as Disposable[] } as unknown as ExtensionContext
  return registerGitCommands(context, env, mgr, graph, statusBar)
}

export async function activate(context: ExtensionContext): Promise<void> {
  const root = workspace.rootPath
  if (!root) {
    console.info('[git] no workspace folder open; git source control disabled')
    context.subscriptions.push(...registerGitGraphStubs())
    return
  }

  const out = window.createOutputChannel('Git')
  context.subscriptions.push(out)
  const log = (msg: string): void => out.appendLine(msg)
  // Let failure toasts offer an "Open Git Log" button that reveals this channel.
  setGitLogShower(() => out.show())

  const scanOpts = await readScanConfig()
  const env: GitEnv = { root, scanOpts, log }
  const initial = await discoverRepos(root, scanOpts, log)

  let mgr: RepositoryManager | undefined
  // Stubs answering "no repos yet" for a restored Git Graph tab / dirty-diff
  // HEAD lookups. Held in a bag so the late setup can dispose them before
  // registering the real commands — the registry throws on duplicates.
  let stubs: Disposable[] = []
  if (initial.repos.length > 0) {
    mgr = setupRepositories(context, env, initial)
  } else {
    stubs = [
      commands.registerCommand('git.getHeadContent', () => null),
      commands.registerCommand('git.checkIgnore', () => []),
      ...registerGitGraphStubs(),
    ]
    context.subscriptions.push(...stubs)
    console.info(`[git] no git repository found under ${root}; watching for one to appear`)
  }

  const onPossibleRepos = async (candidates: readonly string[]): Promise<void> => {
    if (!mgr) {
      // Nothing was known at startup: any candidate may complete the picture
      // (root repo, nested repos, submodules), so rescan wholesale.
      const found = await discoverRepos(root, scanOpts, log)
      if (found.repos.length === 0) return
      for (const s of stubs) s.dispose()
      stubs = []
      log(`[git] repository appeared under ${root}; enabling source control`)
      mgr = setupRepositories(context, env, found)
      return
    }
    const known = mgr
    for (const candidate of candidates) {
      const dir = joinCandidate(root, candidate)
      if (known.has(dir)) continue
      const confirmed = await detectRepoRoot(dir)
      if (!confirmed || known.has(confirmed)) continue
      // The workspace folder itself becoming a repo upgrades to main.
      const isMain = norm(confirmed) === norm(root)
      const repo = known.add(confirmed, {
        label: isMain ? 'Git' : `Git: ${basename(confirmed)}`,
      })
      if (isMain) known.setMainRoot(confirmed)
      log(`[git] late repository detected: ${confirmed}`)
      void repo.refresh({ fetch: true, silent: true })
    }
  }

  // Mirror VSCode's onPossibleGitRepositoryChange: a `.git` entry appearing
  // anywhere in the workspace (git init / clone / submodule update) brings the
  // new repo online without a window reload.
  const watcher = new PossibleRepoWatcher(root, (dirs) => void onPossibleRepos(dirs), log)
  watcher.start()
  context.subscriptions.push(watcher)
}

export function deactivate(): void {
  // Disposables on context.subscriptions (repository, watcher, commands) handle teardown.
}
