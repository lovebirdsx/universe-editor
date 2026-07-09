/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side extension enablement service. Mirrors VSCode's
 *  `IWorkbenchExtensionEnablementService`: it merges two sources of truth into a
 *  single enablement decision per extension —
 *    - GLOBAL state: persisted in the main process (`extensions.json` enablement
 *      map, via IExtensionManagementService.getDisabledIds/setEnablement).
 *    - WORKSPACE state: persisted in the renderer's WORKSPACE-scope storage, so
 *      it follows the open folder and resets when the workspace changes.
 *
 *  Resolution precedence (VSCode semantics): a workspace override (enabled OR
 *  disabled) wins over the global state; absent a workspace override, the global
 *  state applies; the default is enabled.
 *
 *  The "effective disabled ids" this computes are what the extension hosts (both
 *  trusted built-in and restricted external tiers) filter out of their scan.
 *
 *  Malicious extensions are force-disabled globally by the existing quarantine
 *  flow (ExtensionsContribution → management.quarantineMalicious), so they
 *  surface here as `DisabledGlobally`; this service owns only user enablement.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  Emitter,
  IStorageService,
  IWorkspaceService,
  StorageScope,
  type Event,
} from '@universe-editor/platform'
import { IExtensionManagementService } from '../../../shared/ipc/extensionManagementService.js'

/** User-facing enablement states. Mirrors VSCode's `EnablementState` (user subset). */
export enum EnablementState {
  DisabledGlobally,
  DisabledWorkspace,
  EnabledGlobally,
  EnabledWorkspace,
}

/** WORKSPACE-scope storage shape: the ids explicitly overridden in this folder. */
interface IWorkspaceEnablement {
  readonly enabled: string[]
  readonly disabled: string[]
}

const WORKSPACE_ENABLEMENT_KEY = 'extensions.enablement.workspace'

export interface IExtensionEnablementService {
  readonly _serviceBrand: undefined

  /** Fires when any enablement state changes (global or workspace). */
  readonly onDidChangeEnablement: Event<void>

  /** Whether a workspace folder is open (workspace-scope actions require one). */
  hasWorkspace(): boolean

  /** The resolved enablement state for an extension id. */
  getEnablementState(id: string): Promise<EnablementState>

  /** True when the id resolves to an enabled state. */
  isEnabled(id: string): Promise<boolean>

  /** True only when a workspace is open (workspace overrides need a folder). */
  canChangeWorkspaceEnablement(): boolean

  /**
   * Set an extension's enablement to a target user state. Global states write
   * through to the main-process enablement map; workspace states write to
   * WORKSPACE storage. Throws for workspace states when no folder is open.
   */
  setEnablement(id: string, state: EnablementState): Promise<void>

  /**
   * The ids that should be filtered out of a host scan given the current
   * workspace + global state. This is the single input the hosts consume; both
   * tiers filter their scanned extensions by it.
   */
  getEffectiveDisabledIds(): Promise<string[]>
}

export const IExtensionEnablementService = createDecorator<IExtensionEnablementService>(
  'extensionEnablementService',
)

export class ExtensionEnablementService extends Disposable implements IExtensionEnablementService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeEnablement = this._register(new Emitter<void>())
  readonly onDidChangeEnablement: Event<void> = this._onDidChangeEnablement.event

  constructor(
    @IExtensionManagementService private readonly _management: IExtensionManagementService,
    @IStorageService private readonly _storage: IStorageService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
  ) {
    super()
  }

  hasWorkspace(): boolean {
    return this._workspace.current !== null
  }

  canChangeWorkspaceEnablement(): boolean {
    return this.hasWorkspace()
  }

  async getEnablementState(id: string): Promise<EnablementState> {
    const ws = await this._readWorkspace()
    if (ws.disabled.includes(id)) return EnablementState.DisabledWorkspace
    if (ws.enabled.includes(id)) return EnablementState.EnabledWorkspace

    const globalDisabled = await this._management.getDisabledIds()
    return globalDisabled.includes(id)
      ? EnablementState.DisabledGlobally
      : EnablementState.EnabledGlobally
  }

  async isEnabled(id: string): Promise<boolean> {
    const state = await this.getEnablementState(id)
    return state === EnablementState.EnabledGlobally || state === EnablementState.EnabledWorkspace
  }

  async setEnablement(id: string, state: EnablementState): Promise<void> {
    if (
      (state === EnablementState.EnabledWorkspace || state === EnablementState.DisabledWorkspace) &&
      !this.hasWorkspace()
    ) {
      throw new Error('no workspace open for workspace-scope enablement')
    }

    switch (state) {
      case EnablementState.EnabledGlobally:
        await this._clearWorkspace(id)
        await this._management.setEnablement(id, true)
        break
      case EnablementState.DisabledGlobally:
        await this._clearWorkspace(id)
        await this._management.setEnablement(id, false)
        break
      case EnablementState.EnabledWorkspace:
        await this._setWorkspace(id, true)
        break
      case EnablementState.DisabledWorkspace:
        await this._setWorkspace(id, false)
        break
    }
    // Global writes fire onDidChangeExtensions (→ our listener); workspace writes
    // don't, so fire explicitly to refresh consumers.
    this._onDidChangeEnablement.fire()
  }

  async getEffectiveDisabledIds(): Promise<string[]> {
    const [globalDisabled, ws] = await Promise.all([
      this._management.getDisabledIds(),
      this._readWorkspace(),
    ])
    const disabled = new Set<string>()
    // Global disabled, unless a workspace enable overrides it.
    for (const id of globalDisabled) {
      if (!ws.enabled.includes(id)) disabled.add(id)
    }
    // Workspace-disabled always adds.
    for (const id of ws.disabled) disabled.add(id)
    return [...disabled]
  }

  private async _readWorkspace(): Promise<IWorkspaceEnablement> {
    if (!this.hasWorkspace()) return { enabled: [], disabled: [] }
    const stored = await this._storage.get<IWorkspaceEnablement>(
      WORKSPACE_ENABLEMENT_KEY,
      StorageScope.WORKSPACE,
    )
    return {
      enabled: Array.isArray(stored?.enabled) ? stored!.enabled : [],
      disabled: Array.isArray(stored?.disabled) ? stored!.disabled : [],
    }
  }

  private async _writeWorkspace(next: IWorkspaceEnablement): Promise<void> {
    await this._storage.set(WORKSPACE_ENABLEMENT_KEY, next, StorageScope.WORKSPACE)
  }

  /** Move `id` into the workspace enabled/disabled group, removing it from the other. */
  private async _setWorkspace(id: string, enabled: boolean): Promise<void> {
    const ws = await this._readWorkspace()
    await this._writeWorkspace({
      enabled: enabled ? [...new Set([...ws.enabled, id])] : ws.enabled.filter((x) => x !== id),
      disabled: enabled ? ws.disabled.filter((x) => x !== id) : [...new Set([...ws.disabled, id])],
    })
  }

  /** Remove any workspace override for `id` (reverting to the global state). */
  private async _clearWorkspace(id: string): Promise<void> {
    if (!this.hasWorkspace()) return
    const ws = await this._readWorkspace()
    if (!ws.enabled.includes(id) && !ws.disabled.includes(id)) return
    await this._writeWorkspace({
      enabled: ws.enabled.filter((x) => x !== id),
      disabled: ws.disabled.filter((x) => x !== id),
    })
  }
}
