/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side IConfigurationResolverService. Wires the abstract variable
 *  resolver (platform) to concrete data sources: workspace folder, active editor,
 *  configuration, host platform, and a one-shot main-process environment snapshot
 *  (env / userHome / cwd — values a browser context cannot read itself).
 *
 *  Mirrors VSCode's BaseConfigurationResolverService: it owns the IVariableResolveContext
 *  and feeds userHome / env as promises so `${userHome}` / `${env:X}` resolve lazily.
 *--------------------------------------------------------------------------------------------*/

import {
  AbstractVariableResolverService,
  createDecorator,
  IConfigurationService,
  IEditorService,
  IHostService,
  InstantiationType,
  IWorkspaceService,
  registerSingleton,
  URI,
  type HostPlatform,
  type IConfigurationResolverService,
  type IProcessEnvironment,
  type IVariableResolveContext,
} from '@universe-editor/platform'
import { IEnvironmentSnapshotService } from '../../../shared/ipc/environmentSnapshotService.js'

export const IConfigurationResolverServiceRenderer = createDecorator<IConfigurationResolverService>(
  'configurationResolverServiceRenderer',
)

class RendererVariableResolveContext implements IVariableResolveContext {
  constructor(
    private readonly _workspace: IWorkspaceService,
    private readonly _editor: IEditorService,
    private readonly _config: IConfigurationService,
  ) {}

  getFolderUri(folderName: string): URI | undefined {
    const current = this._workspace.current
    if (!current) return undefined
    // Single-folder workspace: only the current folder is addressable, matched by name.
    return current.name === folderName ? current.folder : undefined
  }

  getWorkspaceFolderCount(): number {
    return this._workspace.current ? 1 : 0
  }

  getConfigurationValue(_folderUri: URI | undefined, section: string): string | undefined {
    const value = this._config.get<unknown>(section)
    if (value === undefined || value === null) return undefined
    return typeof value === 'object' ? (value as never) : String(value)
  }

  getExecPath(): string | undefined {
    return undefined
  }

  getFilePath(): string | undefined {
    // activeEditor is typed as the legacy IEditorInput (no `resource`); every real
    // instance is an EditorInput carrying one, so read it structurally.
    const active = this._editor.activeEditor.get() as { resource?: URI } | undefined
    return active?.resource?.fsPath
  }

  getSelectedText(): string | undefined {
    return undefined
  }

  getLineNumber(): string | undefined {
    return undefined
  }

  getColumnNumber(): string | undefined {
    return undefined
  }

  async getExtension(): Promise<{ readonly extensionLocation: URI } | undefined> {
    return undefined
  }
}

export class ConfigurationResolverService
  extends AbstractVariableResolverService
  implements IConfigurationResolverService
{
  declare readonly _serviceBrand: undefined

  constructor(
    @IWorkspaceService workspace: IWorkspaceService,
    @IEditorService editor: IEditorService,
    @IConfigurationService config: IConfigurationService,
    @IHostService host: IHostService,
    @IEnvironmentSnapshotService snapshotService: IEnvironmentSnapshotService,
  ) {
    const platform: HostPlatform = host.platform
    // Fetch the environment snapshot once; env / userHome resolve off these
    // promises the same way VSCode caches _envVariablesPromise / _userHomePromise.
    const snapshot = snapshotService.getSnapshot()
    const userHomePromise = snapshot.then((s) => s.userHome)
    const envPromise: Promise<IProcessEnvironment> = snapshot.then((s) => s.env)

    super(
      new RendererVariableResolveContext(workspace, editor, config),
      platform,
      userHomePromise,
      envPromise,
    )
  }
}

registerSingleton(
  IConfigurationResolverServiceRenderer,
  ConfigurationResolverService,
  InstantiationType.Delayed,
)
