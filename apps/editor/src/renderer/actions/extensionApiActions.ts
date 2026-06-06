/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Internal `_workbench.*` commands that back the extension API. The extension
 *  host can only invoke `_workbench.*` commands in the renderer (see
 *  MainThreadCommands), so anything an extension needs from the renderer that
 *  isn't a dedicated RPC channel is surfaced here as a command.
 *--------------------------------------------------------------------------------------------*/

import { Action2, IConfigurationService, type ServicesAccessor } from '@universe-editor/platform'

/** Backs `workspace.getConfiguration(section).get(key, default)` for extensions. */
export class GetConfigurationAction extends Action2 {
  static readonly ID = '_workbench.getConfiguration'

  constructor() {
    super({ id: GetConfigurationAction.ID, title: 'Get Configuration' })
  }

  override run(accessor: ServicesAccessor, key: string, defaultValue?: unknown): unknown {
    const value = accessor.get(IConfigurationService).get(key)
    return value === undefined ? defaultValue : value
  }
}
