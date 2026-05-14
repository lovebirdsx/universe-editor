/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/instantiation/common/instantiation.ts
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../base/lifecycle.js'
import type * as descriptors from './descriptors.js'
import type { ServiceCollection } from './serviceCollection.js'

// ------ internal util

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace _util {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const serviceIds = new Map<string, ServiceIdentifier<any>>()

  export const DI_TARGET = '$di$target'
  export const DI_DEPENDENCIES = '$di$dependencies'

  export function getServiceDependencies(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    ctor: Function,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): { id: ServiceIdentifier<any>; index: number }[] {
    return (ctor as DI_TARGET_OBJ)[DI_DEPENDENCIES] ?? []
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  export interface DI_TARGET_OBJ extends Function {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    [DI_TARGET]: Function
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [DI_DEPENDENCIES]: { id: ServiceIdentifier<any>; index: number }[]
  }
}

// --- interfaces ------

export type BrandedService = { _serviceBrand: undefined }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IConstructorSignature<T, Args extends any[] = []> {
  new <Services extends BrandedService[]>(...args: [...Args, ...Services]): T
}

export interface ServicesAccessor {
  get<T>(id: ServiceIdentifier<T>): T
}

export const IInstantiationService = createDecorator<IInstantiationService>('instantiationService')

/**
 * Given a list of arguments as a tuple, attempt to extract the leading, non-service arguments
 * to their own tuple.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GetLeadingNonServiceArgs<TArgs extends any[]> = TArgs extends []
  ? []
  : TArgs extends [...infer TFirst, BrandedService]
    ? GetLeadingNonServiceArgs<TFirst>
    : TArgs

export interface IInstantiationService {
  readonly _serviceBrand: undefined

  /**
   * Synchronously creates an instance that is denoted by the descriptor
   */
  createInstance<T>(descriptor: descriptors.SyncDescriptor0<T>): T
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance<Ctor extends new (...args: any[]) => unknown, R extends InstanceType<Ctor>>(
    ctor: Ctor,
    ...args: GetLeadingNonServiceArgs<ConstructorParameters<Ctor>>
  ): R

  /**
   * Calls a function with a service accessor.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invokeFunction<R, TS extends any[] = []>(
    fn: (accessor: ServicesAccessor, ...args: TS) => R,
    ...args: TS
  ): R

  /**
   * Creates a child of this service which inherits all current services
   * and adds/overwrites the given services.
   */
  createChild(services: ServiceCollection, store?: DisposableStore): IInstantiationService

  /**
   * Disposes this instantiation service and all services it created.
   */
  dispose(): void
}

/**
 * Identifies a service of type `T`.
 */
export interface ServiceIdentifier<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (...args: any[]): void
  type: T
}

function storeServiceDependency(
  id: ServiceIdentifier<unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  target: Function,
  index: number,
): void {
  const t = target as _util.DI_TARGET_OBJ
  if (t[_util.DI_TARGET] === target) {
    t[_util.DI_DEPENDENCIES].push({ id, index })
  } else {
    t[_util.DI_DEPENDENCIES] = [{ id, index }]
    t[_util.DI_TARGET] = target
  }
}

/**
 * The *only* valid way to create a {@link ServiceIdentifier}.
 */
export function createDecorator<T>(serviceId: string): ServiceIdentifier<T> {
  if (_util.serviceIds.has(serviceId)) {
    return _util.serviceIds.get(serviceId)!
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const id = function (target: Function, _key: string, index: number) {
    if (arguments.length !== 3) {
      throw new Error('@IServiceName-decorator can only be used to decorate a parameter')
    }
    storeServiceDependency(id, target, index)
  } as ServiceIdentifier<T>

  id.toString = () => serviceId

  _util.serviceIds.set(serviceId, id)
  return id
}

export function refineServiceDecorator<T1, T extends T1>(
  serviceIdentifier: ServiceIdentifier<T1>,
): ServiceIdentifier<T> {
  return serviceIdentifier as ServiceIdentifier<T>
}
