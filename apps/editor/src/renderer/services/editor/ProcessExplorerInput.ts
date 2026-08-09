/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProcessExplorerInput — a stateless virtual EditorInput. The editor renders
 *  live data from IProcessMonitorService on mount, so the input carries no
 *  payload and a fixed resource makes it a singleton tab.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, localize, URI } from '@universe-editor/platform'

export class ProcessExplorerInput extends EditorInput {
  static readonly TYPE_ID = 'processExplorer'

  override get typeId(): string {
    return ProcessExplorerInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'process-explorer', path: '/' })
  }

  override get id(): string {
    return 'process-explorer'
  }

  override getName(): string {
    return localize('processExplorer.title', 'Process Explorer')
  }

  override serialize(): Record<string, never> {
    return {}
  }

  static deserialize(): ProcessExplorerInput {
    return new ProcessExplorerInput()
  }
}
