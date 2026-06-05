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
import { detectRepoRoot } from './gitService.js'
import { Repository } from './repository.js'

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

  const repo = new Repository(repoRoot)
  context.subscriptions.push(repo)
  void repo.refresh()

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
    commands.registerCommand('git.refresh', () => repo.refresh()),

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

    commands.registerCommand('git.sync', () => repo.sync()),
    commands.registerCommand('git.pull', () => repo.pull()),
    commands.registerCommand('git.push', () => repo.push()),
    commands.registerCommand('git.discardAll', () => repo.discardAll()),

    commands.registerCommand('git.openChange', (...args: unknown[]) => {
      const [arg, options] = args as [unknown, ({ pinned?: boolean } | undefined)?]
      const path = resourcePath(arg)
      return path ? repo.openChange(path, options?.pinned ?? false) : undefined
    }),
  )
}

export function deactivate(): void {
  // Disposables on context.subscriptions (repository, watcher, commands) handle teardown.
}
