/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resource-keyed Map / Set.
 *
 *  Adapted from VSCode's `ResourceMap`/`ResourceSet` (vs/base/common/map.ts):
 *  a Map/Set keyed by a resource's comparison key rather than object identity,
 *  so two URIs that address the same resource (separators, drive-letter case,
 *  path case on win32/darwin) map to the same entry.
 *
 *  The key function is injected — callers pass `uriIdentityService.getComparisonKey`
 *  (or a platform-bound `getResourceComparisonKey`) so de-dup uses the exact same
 *  identity as `isEqualResource`.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from './uri.js'

export type ResourceKeyFn = (resource: URI) => string

export class ResourceMap<V> implements Map<URI, V> {
  private readonly _map = new Map<string, { readonly uri: URI; value: V }>()

  constructor(private readonly _toKey: ResourceKeyFn) {}

  get size(): number {
    return this._map.size
  }

  set(resource: URI, value: V): this {
    this._map.set(this._toKey(resource), { uri: resource, value })
    return this
  }

  get(resource: URI): V | undefined {
    return this._map.get(this._toKey(resource))?.value
  }

  has(resource: URI): boolean {
    return this._map.has(this._toKey(resource))
  }

  delete(resource: URI): boolean {
    return this._map.delete(this._toKey(resource))
  }

  clear(): void {
    this._map.clear()
  }

  forEach(callbackfn: (value: V, key: URI, map: Map<URI, V>) => void, thisArg?: unknown): void {
    for (const entry of this._map.values()) {
      callbackfn.call(thisArg, entry.value, entry.uri, this)
    }
  }

  *values(): IterableIterator<V> {
    for (const entry of this._map.values()) yield entry.value
  }

  *keys(): IterableIterator<URI> {
    for (const entry of this._map.values()) yield entry.uri
  }

  *entries(): IterableIterator<[URI, V]> {
    for (const entry of this._map.values()) yield [entry.uri, entry.value]
  }

  [Symbol.iterator](): IterableIterator<[URI, V]> {
    return this.entries()
  }

  get [Symbol.toStringTag](): string {
    return 'ResourceMap'
  }
}

export class ResourceSet implements Set<URI> {
  private readonly _map: ResourceMap<URI>

  constructor(toKey: ResourceKeyFn) {
    this._map = new ResourceMap<URI>(toKey)
  }

  get size(): number {
    return this._map.size
  }

  add(resource: URI): this {
    this._map.set(resource, resource)
    return this
  }

  has(resource: URI): boolean {
    return this._map.has(resource)
  }

  delete(resource: URI): boolean {
    return this._map.delete(resource)
  }

  clear(): void {
    this._map.clear()
  }

  forEach(callbackfn: (value: URI, value2: URI, set: Set<URI>) => void, thisArg?: unknown): void {
    this._map.forEach((uri) => callbackfn.call(thisArg, uri, uri, this))
  }

  values(): IterableIterator<URI> {
    return this._map.keys()
  }

  keys(): IterableIterator<URI> {
    return this._map.keys()
  }

  *entries(): IterableIterator<[URI, URI]> {
    for (const uri of this._map.keys()) yield [uri, uri]
  }

  [Symbol.iterator](): IterableIterator<URI> {
    return this._map.keys()
  }

  get [Symbol.toStringTag](): string {
    return 'ResourceSet'
  }
}
