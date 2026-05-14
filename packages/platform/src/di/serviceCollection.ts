/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/instantiation/common/serviceCollection.ts
 *--------------------------------------------------------------------------------------------*/

import type { ServiceIdentifier } from './instantiation.js'
import type { SyncDescriptor } from './descriptors.js'

export class ServiceCollection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _entries = new Map<ServiceIdentifier<any>, any>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...entries: [ServiceIdentifier<any>, any][]) {
    for (const [id, service] of entries) {
      this.set(id, service)
    }
  }

  set<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
  ): T | SyncDescriptor<T> {
    const result = this._entries.get(id)
    this._entries.set(id, instanceOrDescriptor)
    return result
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  has(id: ServiceIdentifier<any>): boolean {
    return this._entries.has(id)
  }

  get<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> {
    return this._entries.get(id)
  }
}
