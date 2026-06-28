/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/instantiation/common/descriptors.ts
 *--------------------------------------------------------------------------------------------*/

import type { ServicesAccessor } from './instantiation.js'

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

class FactoryPlaceholder {
  constructor() {
    throw new Error('SyncFactoryDescriptor placeholder ctor must not be constructed')
  }
}

/**
 * Descriptor that builds its service via an explicit factory instead of a
 * decorated constructor. Use this when a service mixes @-injected dependencies
 * with non-branded static params (spawner stubs, file paths) — the factory
 * resolves the injected ones through the accessor and passes the static ones
 * positionally, so no `undefined` padding slots are needed (the source of the
 * `SyncDescriptor(Foo, [undefined, undefined], false)` fragility in main).
 *
 * It extends {@link SyncDescriptor} so every existing `instanceof SyncDescriptor`
 * branch in the kernel treats it as a descriptor. The placeholder `ctor` carries
 * no DI metadata, so the dependency-graph walk sees it as a leaf: the factory's
 * own dependencies are resolved lazily via `accessor.get(...)` at build time
 * (the same on-demand path constructor injection uses), and the kernel's
 * recursive-instantiation guard still catches cycles.
 */
export class SyncFactoryDescriptor<T> extends SyncDescriptor<T> {
  readonly factory: (accessor: ServicesAccessor) => T

  constructor(
    factory: (accessor: ServicesAccessor) => T,
    supportsDelayedInstantiation: boolean = false,
  ) {
    super(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      FactoryPlaceholder as unknown as new (...args: any[]) => T,
      [],
      supportsDelayedInstantiation,
    )
    this.factory = factory
  }
}
