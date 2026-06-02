/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/instantiation/common/extensions.ts
 *--------------------------------------------------------------------------------------------*/

import { SyncDescriptor } from './descriptors.js'
import { BrandedService, ServiceIdentifier } from './instantiation.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _registry: [ServiceIdentifier<any>, SyncDescriptor<any>][] = []

export const enum InstantiationType {
  /**
   * Instantiate this service as soon as a consumer depends on it. The instance
   * is a real object (no Proxy), so any construction-time side effects run
   * immediately on first reference.
   */
  Eager = 0,

  /**
   * Instantiate this service as soon as a consumer uses it. Until then the
   * container hands out a lazy Proxy: `onDid*` / `onWill*` subscriptions are
   * buffered, and the real instance is created on first non-event access.
   */
  Delayed = 1,
}

export function registerSingleton<T, Services extends BrandedService[]>(
  id: ServiceIdentifier<T>,
  ctor: new (...services: Services) => T,
  supportsDelayedInstantiation: InstantiationType,
): void
export function registerSingleton<T>(id: ServiceIdentifier<T>, descriptor: SyncDescriptor<T>): void
export function registerSingleton<T, Services extends BrandedService[]>(
  id: ServiceIdentifier<T>,
  ctorOrDescriptor: (new (...services: Services) => T) | SyncDescriptor<T>,
  supportsDelayedInstantiation?: InstantiationType,
): void {
  if (!(ctorOrDescriptor instanceof SyncDescriptor)) {
    ctorOrDescriptor = new SyncDescriptor<T>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctorOrDescriptor as new (...args: any[]) => T,
      [],
      supportsDelayedInstantiation === InstantiationType.Delayed,
    )
  }

  _registry.push([id, ctorOrDescriptor])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSingletonServiceDescriptors(): [ServiceIdentifier<any>, SyncDescriptor<any>][] {
  return _registry
}
