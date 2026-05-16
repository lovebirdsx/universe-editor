/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor (Trace removed).
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/instantiation/common/instantiationService.ts
 *--------------------------------------------------------------------------------------------*/

import { GlobalIdleValue } from '../base/async.js'
import { Event } from '../base/event.js'
import {
  DisposableStore,
  IDisposable,
  dispose,
  isDisposable,
  toDisposable,
} from '../base/lifecycle.js'
import { LinkedList } from '../base/linkedList.js'
import { SyncDescriptor, SyncDescriptor0 } from './descriptors.js'
import { Graph } from './graph.js'
import {
  GetLeadingNonServiceArgs,
  IInstantiationService,
  ServiceIdentifier,
  ServicesAccessor,
  _util,
} from './instantiation.js'
import { ServiceCollection } from './serviceCollection.js'

class CyclicDependencyError extends Error {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(graph: Graph<any>) {
    super('cyclic dependency between services')
    this.message =
      graph.findCycleSlow() ?? `UNABLE to detect cycle, dumping graph: \n${graph.toString()}`
  }
}

export class InstantiationService implements IInstantiationService {
  declare readonly _serviceBrand: undefined

  private _isDisposed = false
  private readonly _servicesToMaybeDispose = new Set<unknown>()
  private readonly _children = new Set<InstantiationService>()

  constructor(
    private readonly _services: ServiceCollection = new ServiceCollection(),
    private readonly _strict: boolean = false,
    private readonly _parent?: InstantiationService,
  ) {
    this._services.set(IInstantiationService, this)
  }

  dispose(): void {
    if (!this._isDisposed) {
      this._isDisposed = true
      dispose(this._children)
      this._children.clear()

      for (const candidate of this._servicesToMaybeDispose) {
        if (isDisposable(candidate)) {
          candidate.dispose()
        }
      }
      this._servicesToMaybeDispose.clear()
    }
  }

  private _throwIfDisposed(): void {
    if (this._isDisposed) {
      throw new Error('InstantiationService has been disposed')
    }
  }

  createChild(services: ServiceCollection, store?: DisposableStore): IInstantiationService {
    this._throwIfDisposed()

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const that = this
    const result = new (class extends InstantiationService {
      override dispose(): void {
        that._children.delete(result)
        super.dispose()
      }
    })(services, this._strict, this)
    this._children.add(result)

    store?.add(result)
    return result
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invokeFunction<R, TS extends any[] = []>(
    fn: (accessor: ServicesAccessor, ...args: TS) => R,
    ...args: TS
  ): R {
    this._throwIfDisposed()

    let done = false
    try {
      const accessor: ServicesAccessor = {
        get: <T>(id: ServiceIdentifier<T>): T => {
          if (done) {
            throw new Error(
              'service accessor is only valid during the invocation of its target method',
            )
          }
          const result = this._getOrCreateServiceInstance(id)
          if (!result) {
            this._throwIfStrict(`[invokeFunction] unknown service '${id}'`, false)
          }
          return result
        },
      }
      return fn(accessor, ...args)
    } finally {
      done = true
    }
  }

  createInstance<T>(descriptor: SyncDescriptor0<T>): T
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance<Ctor extends new (...args: any[]) => unknown, R extends InstanceType<Ctor>>(
    ctor: Ctor,
    ...args: GetLeadingNonServiceArgs<ConstructorParameters<Ctor>>
  ): R
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance(ctorOrDescriptor: any | SyncDescriptor<any>, ...rest: unknown[]): unknown {
    this._throwIfDisposed()

    if (ctorOrDescriptor instanceof SyncDescriptor) {
      return this._createInstance(
        ctorOrDescriptor.ctor,
        ctorOrDescriptor.staticArguments.concat(rest),
      )
    } else {
      return this._createInstance(ctorOrDescriptor, rest)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _createInstance<T>(ctor: any, args: unknown[] = []): T {
    const serviceDependencies = _util.getServiceDependencies(ctor).sort((a, b) => a.index - b.index)
    const serviceArgs: unknown[] = []
    for (const dependency of serviceDependencies) {
      const service = this._getOrCreateServiceInstance(dependency.id)
      if (!service) {
        this._throwIfStrict(
          `[createInstance] ${ctor.name} depends on UNKNOWN service ${dependency.id}.`,
          false,
        )
      }
      serviceArgs.push(service)
    }

    const firstServiceArgPos =
      serviceDependencies.length > 0 ? (serviceDependencies[0]?.index ?? args.length) : args.length

    if (args.length !== firstServiceArgPos) {
      console.trace(
        `[createInstance] First service dependency of ${ctor.name} at position ${firstServiceArgPos + 1} conflicts with ${args.length} static arguments`,
      )
      const delta = firstServiceArgPos - args.length
      if (delta > 0) {
        args = args.concat(new Array(delta))
      } else {
        args = args.slice(0, firstServiceArgPos)
      }
    }

    return Reflect.construct<unknown[], T>(ctor, args.concat(serviceArgs))
  }

  private _setCreatedServiceInstance<T>(id: ServiceIdentifier<T>, instance: T): void {
    if (this._services.get(id) instanceof SyncDescriptor) {
      this._services.set(id, instance)
    } else if (this._parent) {
      this._parent._setCreatedServiceInstance(id, instance)
    } else {
      throw new Error('illegalState - setting UNKNOWN service instance')
    }
  }

  private _getServiceInstanceOrDescriptor<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> {
    const instanceOrDesc = this._services.get(id)
    if (!instanceOrDesc && this._parent) {
      return this._parent._getServiceInstanceOrDescriptor(id)
    }
    return instanceOrDesc
  }

  protected _getOrCreateServiceInstance<T>(id: ServiceIdentifier<T>): T {
    const thing = this._getServiceInstanceOrDescriptor(id)
    if (thing instanceof SyncDescriptor) {
      return this._safeCreateAndCacheServiceInstance(id, thing)
    } else {
      return thing
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _activeInstantiations = new Set<ServiceIdentifier<any>>()

  private _safeCreateAndCacheServiceInstance<T>(
    id: ServiceIdentifier<T>,
    desc: SyncDescriptor<T>,
  ): T {
    if (this._activeInstantiations.has(id)) {
      throw new Error(`illegal state - RECURSIVELY instantiating service '${id}'`)
    }
    this._activeInstantiations.add(id)
    try {
      return this._createAndCacheServiceInstance(id, desc)
    } finally {
      this._activeInstantiations.delete(id)
    }
  }

  private _createAndCacheServiceInstance<T>(id: ServiceIdentifier<T>, desc: SyncDescriptor<T>): T {
    type Triple = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      id: ServiceIdentifier<any>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      desc: SyncDescriptor<any>
    }
    const graph = new Graph<Triple>((data) => data.id.toString())

    let cycleCount = 0
    const stack = [{ id, desc }]
    const seen = new Set<string>()

    while (stack.length) {
      const item = stack.pop()!
      if (seen.has(String(item.id))) {
        continue
      }
      seen.add(String(item.id))
      graph.lookupOrInsertNode(item)

      if (cycleCount++ > 1000) {
        throw new CyclicDependencyError(graph)
      }

      for (const dependency of _util.getServiceDependencies(item.desc.ctor)) {
        const instanceOrDesc = this._getServiceInstanceOrDescriptor(dependency.id)
        if (!instanceOrDesc) {
          this._throwIfStrict(
            `[createInstance] ${id} depends on ${dependency.id} which is NOT registered.`,
            true,
          )
        }

        if (instanceOrDesc instanceof SyncDescriptor) {
          const d = { id: dependency.id, desc: instanceOrDesc }
          graph.insertEdge(item, d)
          stack.push(d)
        }
      }
    }

    while (true) {
      const roots = graph.roots()
      if (roots.length === 0) {
        if (!graph.isEmpty()) {
          throw new CyclicDependencyError(graph)
        }
        break
      }

      for (const { data } of roots) {
        const instanceOrDesc = this._getServiceInstanceOrDescriptor(data.id)
        if (instanceOrDesc instanceof SyncDescriptor) {
          const instance = this._createServiceInstanceWithOwner(
            data.id,
            data.desc.ctor,
            data.desc.staticArguments,
            data.desc.supportsDelayedInstantiation,
          )
          this._setCreatedServiceInstance(data.id, instance)
        }
        graph.removeNode(data)
      }
    }

    return this._getServiceInstanceOrDescriptor(id) as T
  }

  private _createServiceInstanceWithOwner<T>(
    id: ServiceIdentifier<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: any,
    args: unknown[] = [],
    supportsDelayedInstantiation: boolean = false,
  ): T {
    if (this._services.get(id) instanceof SyncDescriptor) {
      return this._createServiceInstance(
        id,
        ctor,
        args,
        supportsDelayedInstantiation,
        this._servicesToMaybeDispose,
      )
    } else if (this._parent) {
      return this._parent._createServiceInstanceWithOwner(
        id,
        ctor,
        args,
        supportsDelayedInstantiation,
      )
    } else {
      throw new Error(`illegalState - creating UNKNOWN service instance ${ctor.name}`)
    }
  }

  private _createServiceInstance<T>(
    _id: ServiceIdentifier<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: any,
    args: unknown[] = [],
    supportsDelayedInstantiation: boolean,
    disposeBucket: Set<unknown>,
  ): T {
    if (!supportsDelayedInstantiation) {
      // eager instantiation
      const result = this._createInstance<T>(ctor, args)
      disposeBucket.add(result)
      return result
    }

    // Lazy instantiation: build a Proxy backed by GlobalIdleValue. The real
    // instance is created on first non-event property access (or when the
    // idle callback fires, whichever comes first). Until then, `onDid*` /
    // `onWill*` event subscribers are kept in `earlyListeners` and reattached
    // to the real service upon materialization.
    //
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this

    type EarlyListenerData = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: Parameters<Event<any>>
      disposable: IDisposable | undefined
    }
    const earlyListeners = new Map<string, LinkedList<EarlyListenerData>>()

    const idle = new GlobalIdleValue<T>(() => {
      const result = self._createInstance<T>(ctor, args)

      // re-attach early listeners to the real service
      for (const [key, values] of earlyListeners) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const candidate = (result as any)[key]
        if (typeof candidate === 'function') {
          for (const value of values) {
            value.disposable = candidate.apply(result, value.listener)
          }
        }
      }
      earlyListeners.clear()
      disposeBucket.add(result)
      return result
    })

    return new Proxy(Object.create(null), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(target: any, key: PropertyKey): unknown {
        if (!idle.isInitialized) {
          if (typeof key === 'string' && (key.startsWith('onDid') || key.startsWith('onWill'))) {
            let list = earlyListeners.get(key)
            if (!list) {
              list = new LinkedList()
              earlyListeners.set(key, list)
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const event: Event<any> = (callback, thisArg, disposables) => {
              if (idle.isInitialized) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (idle.value as any)[key](callback, thisArg, disposables)
              }
              const entry: EarlyListenerData = {
                listener: [callback, thisArg, disposables],
                disposable: undefined,
              }
              const rm = list!.push(entry)
              return toDisposable(() => {
                rm()
                entry.disposable?.dispose()
              })
            }
            return event
          }
        }

        if (key in target) {
          return target[key]
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const obj = idle.value as any
        let prop = obj[key]
        if (typeof prop !== 'function') {
          return prop
        }
        prop = prop.bind(obj)
        target[key] = prop
        return prop
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set(_target: T, p: PropertyKey, value: any): boolean {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(idle.value as any)[p] = value
        return true
      },
      getPrototypeOf(_target: T) {
        return ctor.prototype
      },
    }) as T
  }

  private _throwIfStrict(msg: string, printWarning: boolean): void {
    if (printWarning) {
      console.warn(msg)
    }
    if (this._strict) {
      throw new Error(msg)
    }
  }
}
