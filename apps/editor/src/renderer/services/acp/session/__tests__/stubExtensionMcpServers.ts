/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for IExtensionMcpServersService — empty record by default;
 *  setRecord() swaps the record and fires onDidChange like the real service.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { IExtensionMcpServersService } from '../../../extensions/extensionMcpServersService.js'

export class StubExtensionMcpServersService implements IExtensionMcpServersService {
  declare readonly _serviceBrand: undefined
  readonly whenReady = Promise.resolve()
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange = this._onDidChange.event
  private _rawRecord: Readonly<Record<string, unknown>> = {}

  get rawRecord(): Readonly<Record<string, unknown>> {
    return this._rawRecord
  }

  setContributions(): void {}

  setRecord(record: Record<string, unknown>): void {
    this._rawRecord = record
    this._onDidChange.fire()
  }
}
