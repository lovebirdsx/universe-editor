/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/instantiation/common/descriptors.ts
 *--------------------------------------------------------------------------------------------*/

export class SyncDescriptor<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly ctor: new (...args: any[]) => T
  readonly staticArguments: unknown[]
  readonly supportsDelayedInstantiation: boolean

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: new (...args: any[]) => T,
    staticArguments: unknown[] = [],
    supportsDelayedInstantiation: boolean = false,
  ) {
    this.ctor = ctor
    this.staticArguments = staticArguments
    this.supportsDelayedInstantiation = supportsDelayedInstantiation
  }
}

export interface SyncDescriptor0<T> {
  readonly ctor: new () => T
}
