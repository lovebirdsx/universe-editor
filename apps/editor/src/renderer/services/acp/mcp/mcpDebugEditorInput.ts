/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Editor input for one MCP debugger tab, keyed by `<sessionId>::<serverName>`:
 *  the same session debugging the same server is one tab, and a second session
 *  (or a second server) gets its own.
 *
 *  Not restorable across an editor restart on purpose — the input deliberately
 *  omits `serialize`, so the persistence walk records `null` and the tab is
 *  dropped. A debugger session is tied to a live connection and to whatever the
 *  configuration resolves to *now*; restoring it would mean re-spawning a server
 *  the user never asked for.
 *--------------------------------------------------------------------------------------------*/

import {
  EditorInput,
  IInstantiationService,
  localize,
  URI,
  type IEditorGroup,
  type IEditorGroupsService,
} from '@universe-editor/platform'

export class McpDebugEditorInput extends EditorInput {
  static readonly TYPE_ID = 'mcp.debug'

  private readonly _resource: URI

  constructor(
    /** `<sessionId>::<serverName>` — the key the debug service keeps its state under. */
    readonly key: string,
    readonly serverName: string,
  ) {
    super()
    this._resource = URI.from({
      scheme: 'universe',
      path: `/mcp/debug/${encodeURIComponent(key)}`,
    })
  }

  override get typeId(): string {
    return McpDebugEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  override getName(): string {
    return localize('mcpDebug.tabName', 'MCP: {server}', { server: this.serverName })
  }

  override getIconId(): string {
    return 'plug'
  }
}

/** Locate an already-open debugger tab (and its group) across every group. */
export function findMcpDebugEditor(
  groups: IEditorGroupsService,
  key: string,
): { readonly group: IEditorGroup; readonly editor: McpDebugEditorInput } | undefined {
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor instanceof McpDebugEditorInput && editor.key === key) {
        return { group, editor }
      }
    }
  }
  return undefined
}

/**
 * Focus the debugger's existing tab wherever it lives; open one only when there is
 * none. Same cross-group dedup as the session editor — `IEditorService.openEditor`
 * only dedupes within the active group, which would give two tabs for one debugger.
 */
export function revealMcpDebugEditor(
  groups: IEditorGroupsService,
  inst: IInstantiationService,
  key: string,
  serverName: string,
): McpDebugEditorInput {
  const found = findMcpDebugEditor(groups, key)
  if (found) {
    groups.activateGroup(found.group)
    found.group.setActive(found.editor)
    return found.editor
  }
  const input = inst.createInstance(McpDebugEditorInput, key, serverName)
  const target = groups.activeGroupForOpen
  target.openEditor(input, { activate: true, pinned: true })
  if (target !== groups.activeGroup) groups.activateGroup(target)
  return input
}
