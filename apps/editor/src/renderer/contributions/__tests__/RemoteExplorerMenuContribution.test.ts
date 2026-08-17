/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/RemoteExplorerMenuContribution.ts
 *  — when-clause filtering of the Remote Explorer row context menu.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  MenuId,
  MenuRegistry,
  type IContextKeyService,
  type IDisposable,
} from '@universe-editor/platform'
import { RemoteExplorerMenuContribution } from '../RemoteExplorerMenuContribution.js'
import type { RemoteRowMenuKind } from '../../workbench/remote/RemoteContextMenu.js'
import type { RemoteConnectionStateDto } from '../../../shared/ipc/remoteStatusService.js'

function commandsInMenu(
  contextKeyService: IContextKeyService,
  kind: RemoteRowMenuKind,
  state: RemoteConnectionStateDto | undefined,
  manual = false,
): string[] {
  const scoped = contextKeyService.createScoped({
    remoteRowKind: kind,
    remoteRowState: state ?? '',
    remoteRowManual: manual,
  })
  return MenuRegistry.getMenuItems(MenuId.RemoteExplorerContext, scoped)
    .filter((i): i is { command: string } => 'command' in i)
    .map((i) => i.command)
}

describe('RemoteExplorerMenuContribution', () => {
  let contextKeyService: ContextKeyService
  let contribution: RemoteExplorerMenuContribution | undefined

  beforeEach(() => {
    contextKeyService = new ContextKeyService()
    contribution = new RemoteExplorerMenuContribution()
  })

  afterEach(() => {
    ;(contribution as IDisposable | undefined)?.dispose()
    contextKeyService.dispose()
  })

  it('shows Connect + Forget for a disconnected manual ssh target', () => {
    expect(commandsInMenu(contextKeyService, 'sshTarget', undefined, true)).toEqual([
      'remote.connectToHost',
      'remote.removeManualHost',
    ])
  })

  it('shows only Connect for a disconnected config ssh target', () => {
    expect(commandsInMenu(contextKeyService, 'sshTarget', undefined)).toEqual([
      'remote.connectToHost',
    ])
  })

  it('shows Connect for a disconnected wsl target', () => {
    expect(commandsInMenu(contextKeyService, 'wslTarget', undefined)).toEqual([
      'remote.connectToHost',
    ])
  })

  it('shows Open Folder for a connected ssh target', () => {
    expect(commandsInMenu(contextKeyService, 'sshTarget', 'connected')).toEqual([
      'remote.openFolder',
    ])
  })

  it('shows Retry + Forget for a failed manual ssh target', () => {
    expect(commandsInMenu(contextKeyService, 'sshTarget', 'failed', true)).toEqual([
      'remote.retryConnection',
      'remote.removeManualHost',
    ])
  })

  it('shows Open/Close/Stop for a connected connection', () => {
    expect(commandsInMenu(contextKeyService, 'connection', 'connected')).toEqual([
      'remote.openFolder',
      'remote.closeConnection',
      'remote.stopServer',
    ])
  })

  it('shows only Close for a reconnecting connection', () => {
    expect(commandsInMenu(contextKeyService, 'connection', 'reconnecting')).toEqual([
      'remote.closeConnection',
    ])
  })

  it('shows only Retry for a failed connection', () => {
    expect(commandsInMenu(contextKeyService, 'connection', 'failed')).toEqual([
      'remote.retryConnection',
    ])
  })

  it('shows Open-in-Current/New + Remove from Recent for a recent row', () => {
    expect(commandsInMenu(contextKeyService, 'recent', undefined)).toEqual([
      'workbench.action.openWorkspaceInCurrentWindow',
      'workbench.action.openWorkspaceInNewWindow',
      'workbench.action.removeRecent',
    ])
  })

  it('shows nothing for in-flight connection states', () => {
    for (const state of ['deploying', 'forwarding', 'handshaking'] as const) {
      expect(commandsInMenu(contextKeyService, 'connection', state)).toEqual([])
    }
  })

  it('retracts all items once the contribution is disposed', () => {
    expect(commandsInMenu(contextKeyService, 'sshTarget', undefined).length).toBeGreaterThan(0)
    contribution?.dispose()
    contribution = undefined
    expect(commandsInMenu(contextKeyService, 'sshTarget', undefined)).toEqual([])
  })
})
