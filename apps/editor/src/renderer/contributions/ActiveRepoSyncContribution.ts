/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Pushes the SCM view's currently-selected repository to every provider host via
 *  a per-provider `<providerId>.setActiveRepo` command: the provider that owns the
 *  selection gets the selected rootUri, every other registered provider gets an
 *  argument-less call so it can hide its status-bar entries (a mixed git+p4
 *  workspace would otherwise show both providers' items at once). The selection
 *  lives in the renderer (scmViewState), but argument-less provider commands
 *  (command palette, keybindings, status-bar clicks) execute in the extension
 *  host, where the provider falls back to its active repo. Keeping the host's
 *  active repo in sync with the view makes those entry points operate on the repo
 *  the user is looking at. The command id is derived from the provider id, so the
 *  host stays free of any single SCM's naming — git and p4 each implement their
 *  own setActiveRepo.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  Disposable,
  ICommandService,
  IWorkbenchContribution,
  autorun,
} from '@universe-editor/platform'
import { IScmService, resolveSelectedSourceControl } from '../services/extensions/ScmService.js'
import { scmViewState } from '../workbench/scm/scmViewState.js'

export class ActiveRepoSyncContribution extends Disposable implements IWorkbenchContribution {
  /** Last rootUri pushed per provider id (undefined = pushed "no active repo").
   *  "Never pushed" and "pushed undefined" are distinct: a provider must still
   *  receive the first no-argument (hide) push after starting visible. */
  private readonly _lastPushed = new Map<string, string | undefined>()
  /** Pending rootUri per provider while its `setActiveRepo` command is unregistered. */
  private readonly _pending = new Map<string, string | undefined>()

  constructor(
    @IScmService scmService: IScmService,
    @ICommandService private readonly _commandService: ICommandService,
  ) {
    super()

    this._register(
      autorun((r) => {
        const sourceControls = scmService.sourceControls.read(r)
        if (sourceControls.length === 0) {
          // Host teardown emptied the model: forget the pushed state so the same
          // providers get a fresh push when they re-register — a fresh host's
          // status bar starts visible, so skipping the re-push would leave both
          // providers' entries showing at once.
          this._lastPushed.clear()
          this._pending.clear()
          return
        }
        const selectedRootUri = scmViewState.selectedRepo.read(r)
        const active = resolveSelectedSourceControl(sourceControls, selectedRootUri)
        // Broadcast once per provider (not per source control — a provider can
        // own several repos, e.g. git main + submodules): the selected repo's
        // owner gets its root, every other provider gets undefined.
        for (const providerId of new Set(sourceControls.map((sc) => sc.id))) {
          this._push(providerId, providerId === active?.id ? active?.rootUri : undefined)
        }
      }),
    )

    // The SCM provider registers with the view before its host has registered
    // `setActiveRepo` (extension activation is async), so the first push would
    // otherwise land as a "command not found" no-op. Retry once it appears.
    this._register(
      CommandsRegistry.onDidChangeCommands(() => {
        for (const [providerId, rootUri] of [...this._pending]) {
          this._push(providerId, rootUri)
        }
      }),
    )
    // Extension-host restart self-heals without extra wiring here:
    // `resetSourceControls` empties the model, the autorun then clears the pushed
    // state, so re-registering providers are pushed afresh (a fresh host's status
    // bar starts visible).
  }

  private _push(providerId: string, rootUri: string | undefined): void {
    if (this._lastPushed.has(providerId) && this._lastPushed.get(providerId) === rootUri) return
    const commandId = `${providerId}.setActiveRepo`
    if (!CommandsRegistry.getCommand(commandId)) {
      // Unknown-command tolerant: a provider that doesn't implement setActiveRepo
      // simply never registers it, and nothing is pushed.
      this._pending.set(providerId, rootUri)
      return
    }
    this._lastPushed.set(providerId, rootUri)
    this._pending.delete(providerId)
    // No selection = pass no argument: an explicit undefined becomes null inside
    // the nested args array across the RPC (stripTrailingUndefined in
    // proxyChannel.ts trims only the outer array), so the host never sees undefined.
    if (rootUri === undefined) {
      void this._commandService.executeCommand(commandId)
    } else {
      void this._commandService.executeCommand(commandId, rootUri)
    }
  }
}
