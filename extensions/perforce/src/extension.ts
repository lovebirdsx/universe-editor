/**
 * Perforce extension entry. Discovers the Perforce client (workspace) for the
 * open folder, surfaces it through the SCM API (default + numbered changelist
 * groups driven by `p4 opened` / `p4 changes`), and wires the read-only Phase-1
 * commands (refresh / login / logout / show output / open change). Mutating
 * operations arrive in later phases.
 *
 * `activate` runs inside the extension host process; as a first-party (trusted)
 * extension it may spawn the `p4` CLI directly, exactly like the git extension
 * spawns `git`. Everything is registered on `context.subscriptions`.
 */
import { commands, workspace, window, type ExtensionContext } from '@universe-editor/extension-api'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConcurrencyGate } from './concurrency.js'
import { type P4Connection } from './p4Service.js'
import { PerforceClient, type P4CacheOptions } from './client.js'
import { P4CacheDisk } from './p4CacheDisk.js'
import { ClientManager } from './clientManager.js'
import { P4StatusBarController } from './p4StatusBar.js'
import { AutoEditController } from './autoEdit.js'
import { WorkspaceWatchController } from './workspaceWatcher.js'
import { notifyP4Failure, setP4OutputShower, isMissingCli } from './p4Error.js'
import { changelistIdFromGroupId } from './changelist.js'
import { statusFromAction, fileDiffRevs, displayPath } from './p4GraphParser.js'
import { uriToFsPath } from './pathUtil.js'
import { localize } from './nls.js'

function resourcePath(arg: unknown): string | undefined {
  return (arg as { resourceUri?: string } | undefined)?.resourceUri
}

/** The changelist a group-scoped command targets, from the `scmResourceGroupId`
 *  the host attaches to group actions ('default' or `cl:<n>`). */
function groupChangelistId(arg: unknown): string | undefined {
  const id = (arg as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
  return id === undefined ? undefined : changelistIdFromGroupId(id)
}

/** Resolve the file a file-scoped command acts on: the SCM resource's path when
 *  invoked from the SCM view, else the explorer selection, else the active
 *  editor's file (command-palette / editor-title entry points). Explorer passes
 *  `{ resource }` as a `UriComponents` (its `fsPath` getter is lost over RPC), so
 *  reconstruct the path from scheme + path. */
async function resolveTargetPath(arg: unknown): Promise<string | undefined> {
  const fromResource = resourcePath(arg)
  if (fromResource) return fromResource
  const resource = (arg as { resource?: { scheme?: string; path?: string } } | undefined)?.resource
  const fromExplorer = resource ? uriToFsPath(resource) : undefined
  if (fromExplorer) return fromExplorer
  return commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile')
}

async function readFallbackConnection(): Promise<P4Connection> {
  const cfg = workspace.getConfiguration('perforce')
  const port = await cfg.get('port', '')
  const user = await cfg.get('user', '')
  const client = await cfg.get('client', '')
  return {
    ...(port ? { port } : {}),
    ...(user ? { user } : {}),
    ...(client ? { client } : {}),
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const root = workspace.rootPath
  if (!root) {
    console.error('[perforce] no workspace folder open; perforce source control disabled')
    return
  }

  const cfg = workspace.getConfiguration('perforce')
  if (!(await cfg.get('enabled', true))) {
    console.error('[perforce] disabled via perforce.enabled')
    return
  }

  const out = window.createOutputChannel('Perforce')
  context.subscriptions.push(out)
  const log = (msg: string): void => out.appendLine(msg)
  setP4OutputShower(() => out.show())

  const maxConcurrent = await cfg.get('maxConcurrent', 4)
  const gate = new ConcurrencyGate(maxConcurrent)
  const fallback = await readFallbackConnection()

  // Result caching (server round-trips are expensive). Immutable data (submitted
  // changes, specific revisions) can persist across sessions under the extension's
  // globalStoragePath; mutable workspace state uses a short TTL + post-mutation
  // invalidation. All knobs live under `perforce.cache.*`.
  const cacheEnabled = await cfg.get('cache.enabled', true)
  const workspaceTtlMs = await cfg.get('cache.workspaceTtl', 4000)
  const diskLimitMb = await cfg.get('cache.diskLimitMb', 50)
  const disk =
    cacheEnabled && context.globalStoragePath
      ? P4CacheDisk.open(context.globalStoragePath, diskLimitMb * 1024 * 1024, Date.now, log)
      : undefined
  const cacheOptions: P4CacheOptions = {
    enabled: cacheEnabled,
    workspaceTtlMs,
    ...(disk ? { disk } : {}),
  }

  // Probe for a p4 CLI + a client for this folder. A missing binary or a folder
  // outside any Perforce workspace disables the provider without crashing.
  let client: PerforceClient | undefined
  try {
    client = await PerforceClient.create(root, fallback, gate, cacheOptions, log)
  } catch (err) {
    if (isMissingCli(err)) {
      console.error('[perforce] p4 CLI not found; perforce source control disabled')
    } else {
      console.error('[perforce] client discovery failed', err)
    }
    return
  }
  if (!client) {
    console.error(`[perforce] no Perforce workspace for ${root}; source control disabled`)
    return
  }

  const mgr = new ClientManager()
  context.subscriptions.push(mgr)
  mgr.add(client)

  const statusBar = new P4StatusBarController(mgr)
  context.subscriptions.push(statusBar)
  statusBar.refresh()
  void client.refresh()

  // Low-frequency background polling (opt-in; server has no FS watcher).
  const refreshInterval = await cfg.get('refreshInterval', 0)
  client.startPolling(refreshInterval)

  // Reconcile discovery: when on, every refresh also scans the working tree for
  // uncollected drift (edited / created / deleted on disk but not opened). Off by
  // default — the scan is heavy on large workspaces; use Clean Refresh / Collect
  // to enable it on demand.
  if (await cfg.get('autoReconcile', false)) client.setAutoReconcile(true)

  // Auto-checkout on edit (opt-in). Disabled config → no subscription.
  const autoEdit = new AutoEditController(mgr, log)
  context.subscriptions.push(autoEdit)
  void autoEdit.start(cfg)

  // Watch the opened workspace folder on disk (default on). A save from the
  // editor or an edit from an external tool schedules a reconcile-discovery
  // refresh, so drifted files surface in "changes to reconcile" without a manual
  // Clean Refresh. We watch the opened folder (not the far larger p4 client root)
  // and narrow the reconcile scan to it — see WorkspaceWatchController.
  const watcher = new WorkspaceWatchController(mgr, log)
  context.subscriptions.push(watcher)
  watcher.start(await cfg.get('autoRefresh', true), root)

  context.subscriptions.push(
    // Point argument-less commands at the SCM-selected client. Pushed by the
    // renderer's ActiveRepoSyncContribution as `<providerId>.setActiveRepo`.
    commands.registerCommand('perforce.setActiveRepo', (...args: unknown[]) => {
      mgr.setActive(args[0] as string | undefined)
      statusBar.refresh()
    }),

    commands.registerCommand('perforce.refresh', (arg) => mgr.resolveClient(arg)?.refresh()),
    // Clean refresh additionally runs the `reconcile -n` discovery pass so the
    // "changes to reconcile" group reflects working-tree drift (files edited /
    // created / deleted on disk but not opened yet).
    commands.registerCommand('perforce.cleanRefresh', (arg) =>
      mgr.resolveClient(arg)?.refresh({ reconcile: true }),
    ),

    // Collect (reconcile) a file's working-tree change into open state. From an
    // SCM "changes to reconcile" row: `{ resourceUri }`; from explorer/editor:
    // the active file. A directory target (explorer right-click on a folder)
    // recurses via p4's `<dir>/...` syntax so the whole subtree is collected.
    // Enables discovery so the group keeps tracking drift.
    commands.registerCommand('perforce.reconcile', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      if (!path) return
      const isDirectory = (args[0] as { isDirectory?: boolean } | undefined)?.isDirectory === true
      const target = isDirectory ? `${path.replace(/[/\\]+$/, '')}/...` : path
      await mgr.resolveClient({ resourceUri: path })?.reconcile([target])
    }),

    // Collect every discovered reconcile candidate at once (group title action).
    commands.registerCommand('perforce.reconcileAll', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      await target?.reconcileAll()
    }),

    commands.registerCommand('perforce.showOutput', () => out.show()),

    commands.registerCommand('perforce.login', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const password = await window.showInputBox({
        prompt: localize('perforce.login.prompt', 'Perforce password / ticket'),
      })
      if (password === undefined) return
      const res = await target.login(password)
      if (!res.ok) await notifyP4Failure('login', res.result)
      else await target.refresh()
    }),

    commands.registerCommand('perforce.logout', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const res = await target.logout()
      if (!res.ok) await notifyP4Failure('logout', res.result)
      else await target.refresh()
    }),

    commands.registerCommand('perforce.openFile', async (...args: unknown[]) => {
      const path =
        resourcePath(args[0]) ??
        (await commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile'))
      if (path) await commands.executeCommand('_workbench.openFile', path)
    }),

    commands.registerCommand('perforce.openChange', async (...args: unknown[]) => {
      const [arg] = args
      // From an SCM row: `{ resourceUri }`. From the dirty-diff host / editor
      // title: a bare path string, or undefined → fall back to the active editor.
      const path =
        resourcePath(arg) ??
        (typeof arg === 'string' ? arg : undefined) ??
        (await commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile'))
      if (!path) return
      await mgr.resolveClient({ resourceUri: path })?.openChange(path)
    }),

    // Dirty-diff baseline: the file's have-revision content (host addresses this
    // as `<providerId>.getHeadContent`). Returns null when there's no baseline.
    commands.registerCommand('perforce.getHeadContent', async (...args: unknown[]) => {
      const path = typeof args[0] === 'string' ? args[0] : undefined
      if (!path) return null
      return (await mgr.resolveClient({ resourceUri: path })?.getHeadContent(path)) ?? null
    }),

    // Inline blame: annotate the file (host addresses this as
    // `<providerId>.getBlame`). Returns a BlameResultDto, or null on failure.
    commands.registerCommand('perforce.getBlame', async (...args: unknown[]) => {
      const path = typeof args[0] === 'string' ? args[0] : undefined
      if (!path) return null
      return (await mgr.resolveClient({ resourceUri: path })?.getBlame(path)) ?? null
    }),

    // --- Mutating operations (Phase 2) -------------------------------------
    // File-scoped ops resolve the client from the resource path; explorer/editor
    // entry points fall back to the active editor's file.

    commands.registerCommand('perforce.edit', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      if (!path) return
      await mgr.resolveClient({ resourceUri: path })?.edit([path])
    }),

    commands.registerCommand('perforce.add', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      if (!path) return
      await mgr.resolveClient({ resourceUri: path })?.add([path])
    }),

    commands.registerCommand('perforce.delete', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      if (!path) return
      const target = mgr.resolveClient({ resourceUri: path })
      if (!target) return
      const BTN_DELETE = localize('perforce.btn.delete', 'Mark for Delete')
      const confirm = await window.showWarningMessage(
        localize('perforce.delete.confirm', "Open '{0}' for delete?", { 0: path }),
        BTN_DELETE,
      )
      if (confirm !== BTN_DELETE) return
      await target.delete([path])
    }),

    commands.registerCommand('perforce.revert', async (...args: unknown[]) => {
      const path = resourcePath(args[0])
      if (!path) return
      const target = mgr.resolveClient({ resourceUri: path })
      if (!target) return
      const BTN_REVERT = localize('perforce.btn.revert', 'Revert')
      const confirm = await window.showWarningMessage(
        localize('perforce.revert.confirm', "Revert '{0}'? Local changes will be lost.", {
          0: path,
        }),
        BTN_REVERT,
      )
      if (confirm !== BTN_REVERT) return
      await target.revert([path])
    }),

    commands.registerCommand('perforce.revertUnchanged', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      await target?.revertUnchanged(groupChangelistId(arg))
    }),

    // Revert every open file in a changelist (destructive — confirm first).
    commands.registerCommand('perforce.revertChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg) ?? 'default'
      if (!target) return
      const label =
        changelist === 'default'
          ? localize('perforce.group.default', 'Default Changelist')
          : `#${changelist}`
      const BTN_REVERT = localize('perforce.btn.revertAll', 'Revert All')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.revertChangelist.confirm',
          'Revert all files in {0}? Local changes will be lost.',
          {
            0: label,
          },
        ),
        BTN_REVERT,
      )
      if (confirm !== BTN_REVERT) return
      await target.revertChangelist(changelist)
    }),

    // Submit the default changelist using the SCM input-box description.
    commands.registerCommand('perforce.submitDefault', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const description = target.description
      if (!description.trim()) {
        await window.showWarningMessage(
          localize('perforce.submit.noDescription', 'Type a changelist description first.'),
        )
        return
      }
      const BTN_SUBMIT = localize('perforce.btn.submit', 'Submit')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.submit.confirmDefault',
          'Submit the default changelist to the depot? This cannot be undone.',
        ),
        BTN_SUBMIT,
      )
      if (confirm !== BTN_SUBMIT) return
      if (await target.submit('default', description)) target.description = ''
    }),

    // Submit a numbered changelist (from its group action) — spec is already set.
    commands.registerCommand('perforce.submitChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const BTN_SUBMIT = localize('perforce.btn.submit', 'Submit')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.submit.confirmNumbered',
          'Submit changelist #{0} to the depot? This cannot be undone.',
          { 0: changelist },
        ),
        BTN_SUBMIT,
      )
      if (confirm !== BTN_SUBMIT) return
      await target.submit(changelist)
    }),

    // --- Numbered changelist management (Phase 3) --------------------------

    commands.registerCommand('perforce.newChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const description = await window.showInputBox({
        prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
      })
      if (description === undefined) return
      await target.newChangelist(description)
    }),

    // Move the clicked resource into a changelist chosen from a quick-pick.
    commands.registerCommand('perforce.reopen', async (...args: unknown[]) => {
      const path = resourcePath(args[0])
      if (!path) return
      const target = mgr.resolveClient({ resourceUri: path })
      if (!target) return
      const picks = await target.changelistPicks()
      const choice = await window.showQuickPick(picks, {
        placeHolder: localize('perforce.reopen.placeholder', 'Move file to changelist'),
      })
      if (!choice) return
      let destination = choice.id
      if (destination === 'new') {
        const description = await window.showInputBox({
          prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
        })
        if (description === undefined) return
        const created = await target.newChangelist(description)
        if (!created) return
        destination = created
      }
      await target.reopen(destination, [path])
    }),

    commands.registerCommand('perforce.editChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const current = await target.getChangelistDescription(changelist)
      const description = await window.showInputBox({
        prompt: localize('perforce.editChangelist.prompt', 'Changelist description'),
        value: current,
      })
      if (description === undefined) return
      await target.editChangelistDescription(changelist, description)
    }),

    // --- Shelve / unshelve (Phase 3) --------------------------------------

    commands.registerCommand('perforce.shelve', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') {
        await window.showWarningMessage(
          localize('perforce.shelve.needNumbered', 'Only numbered changelists can be shelved.'),
        )
        return
      }
      await target.shelve(changelist)
    }),

    commands.registerCommand('perforce.unshelve', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      await target.unshelve(changelist)
    }),

    commands.registerCommand('perforce.deleteShelved', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const BTN_DELETE = localize('perforce.btn.deleteShelved', 'Delete Shelved')
      const confirm = await window.showWarningMessage(
        localize('perforce.deleteShelved.confirm', 'Delete shelved files in changelist #{0}?', {
          0: changelist,
        }),
        BTN_DELETE,
      )
      if (confirm !== BTN_DELETE) return
      await target.deleteShelved(changelist)
    }),

    // --- Resolve (Phase 3) ------------------------------------------------

    commands.registerCommand('perforce.resolve', async (...args: unknown[]) => {
      const path = resourcePath(args[0])
      if (!path) return
      await mgr.resolveClient({ resourceUri: path })?.resolve([path])
    }),

    commands.registerCommand('perforce.resolveChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      await target?.resolveChangelist(groupChangelistId(arg) ?? 'default')
    }),

    // --- Perforce Graph (read-only submitted-change history) ----------------
    // The client the graph targets. Defaults to the active client; `setRepo`
    // switches it to another discovered client (multi-client is a later
    // refinement, but the plumbing mirrors git-graph so it's ready).
    ...(() => {
      let graphRoot: string | undefined

      const graphClient = () =>
        (graphRoot ? mgr.resolveClient({ rootUri: graphRoot }) : undefined) ?? mgr.active

      const DEFAULT_MAX = 300

      return [
        commands.registerCommand('perforce-graph.getRepos', () =>
          mgr.all.map((c) => ({ root: c.root, name: c.clientName })),
        ),
        commands.registerCommand('perforce-graph.setRepo', (...args: unknown[]) => {
          const next = args[0] as string
          if (next) graphRoot = next
          return true
        }),
        commands.registerCommand('perforce-graph.getChanges', async (...args: unknown[]) => {
          const opts = (args[0] ?? {}) as { maxChanges?: number }
          const max = opts.maxChanges ?? DEFAULT_MAX
          const target = graphClient()
          if (!target) return null
          const [changes, pendingCount] = await Promise.all([
            target.getGraphChanges(max),
            target.getPendingCount(),
          ])
          if (!changes) return null
          const moreAvailable = changes.length > max
          const visible = changes.slice(0, max)
          const dtos = visible.map((c, i) => ({
            id: c.id,
            parents: visible[i + 1] ? [visible[i + 1]!.id] : [],
            author: c.author,
            client: c.client,
            date: c.date,
            message: c.message,
          }))
          return {
            changes: dtos,
            head: visible[0]?.id ?? null,
            headClient: target.clientName,
            moreAvailable,
            pendingCount,
          }
        }),
        commands.registerCommand('perforce-graph.getChangeDetails', async (...args: unknown[]) => {
          const id = args[0] as string
          const target = graphClient()
          if (!target) return null
          const detail = await target.getGraphChangeDetails(id)
          if (!detail) return null
          return {
            id: detail.id,
            author: detail.author,
            client: detail.client,
            date: detail.date,
            body: detail.body,
            files: detail.files.map((f) => ({
              status: statusFromAction(f.action),
              path: displayPath(f.depotFile),
              oldPath: null,
              depotFile: f.depotFile,
              rev: f.rev,
              localPath: detail.localPaths.get(f.depotFile) ?? null,
            })),
          }
        }),
        commands.registerCommand('perforce-graph.getPendingChanges', async () => {
          const target = graphClient()
          if (!target) return []
          const opened = await target.getOpenedForGraph()
          return opened.map((f) => {
            const status = statusFromAction(f.action)
            return {
              status,
              path: displayPath(f.depotFile),
              oldPath: null,
              depotFile: f.depotFile,
              rev: f.rev ?? '',
              localPath: f.localPath,
            }
          })
        }),
        commands.registerCommand('perforce-graph.openFileDiff', async (...args: unknown[]) => {
          const req = args[0] as {
            depotFile: string
            status: string
            rev: string
            localPath?: string | null
          }
          const target = graphClient()
          if (!target) return
          const { left, right } = fileDiffRevs(req.depotFile, req.status, req.rev)
          const [original, modified] = await Promise.all([
            target.printRevision(left),
            target.printRevision(right),
          ])
          const leftLabel = left ? left.slice(left.indexOf('#')) : '∅'
          const rightLabel = right ? right.slice(right.indexOf('#')) : '∅'
          await commands.executeCommand('_workbench.openDiff', {
            title: `${basename(displayPath(req.depotFile))} (${leftLabel} ↔ ${rightLabel})`,
            originalUri: pathToFileURL(displayPath(req.depotFile)).href,
            original,
            modified,
            pinned: false,
            preserveFocus: false,
            ...(req.localPath ? { openableUri: pathToFileURL(req.localPath).href } : {}),
          })
        }),
        commands.registerCommand(
          'perforce-graph.openWorkingTreeFile',
          async (...args: unknown[]) => {
            const localPath = args[0] as string
            if (!localPath) return
            // Pending files: show the have-revision vs local diff (mirrors the
            // SCM row's Open Changes), falling back to opening the file.
            await mgr.resolveClient({ resourceUri: localPath })?.openChange(localPath)
          },
        ),
      ]
    })(),
  )
}

export function deactivate(): void {
  // Disposables on context.subscriptions (clients, status bar, commands) handle teardown.
}
