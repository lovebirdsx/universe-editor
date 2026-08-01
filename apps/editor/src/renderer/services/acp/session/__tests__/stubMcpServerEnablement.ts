/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  Test stub for IMcpServerEnablementService — in-memory two-scope records;
 *  setEnabled flips synchronously and fires onDidChange like the real service.
 *--------------------------------------------------------------------------------------------*/
import { Emitter, StorageScope } from '@universe-editor/platform'
import type { IMcpServerEnablementService } from '../../mcpServerEnablementService.js'

export class StubMcpServerEnablementService implements IMcpServerEnablementService {
  declare readonly _serviceBrand: undefined
  readonly whenReady = Promise.resolve()
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange = this._onDidChange.event

  readonly records: Record<StorageScope, Record<string, boolean>> = {
    [StorageScope.GLOBAL]: {},
    [StorageScope.WORKSPACE]: {},
  }

  isEnabled(name: string): boolean {
    return (
      this.records[StorageScope.WORKSPACE][name] ?? this.records[StorageScope.GLOBAL][name] ?? true
    )
  }

  getOverride(name: string, scope: StorageScope): boolean | undefined {
    return this.records[scope][name]
  }

  setEnabled(name: string, enabled: boolean, scope: StorageScope): Promise<void> {
    this.records[scope][name] = enabled
    this._onDidChange.fire()
    return Promise.resolve()
  }

  removeOverride(name: string, scope: StorageScope): Promise<void> {
    delete this.records[scope][name]
    this._onDidChange.fire()
    return Promise.resolve()
  }
}
