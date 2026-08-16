/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IUriIdentityService (platform/uriIdentity).
 *
 *  The single entry point for resource / path comparison. It binds the host
 *  platform once (win32/darwin fold case, linux is case-sensitive) so callers
 *  never thread `platform` through by hand and never hand-roll `toLowerCase()` /
 *  `fsPath ===` comparisons.
 *
 *  Case sensitivity is a property of the *filesystem*, not of the machine
 *  running the UI. The host platform is the default, but a filesystem provider
 *  serving another scheme (e.g. a Linux host behind a remote connection, seen
 *  from Windows) registers its own policy via
 *  {@link IUriIdentityService.registerSchemeCaseSensitivity} — otherwise
 *  `/src/Foo.ts` and `/src/foo.ts` on that host would wrongly collapse to one
 *  resource.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { URI } from '../base/uri.js'
import {
  getResourceComparisonKey,
  isEqualResource,
  isEqualOrParentResource,
  type CaseSensitivityResolver,
} from '../base/uri.js'
import {
  arePathsEqual as arePathsEqualFn,
  getPathComparisonKey as getPathComparisonKeyFn,
  isCaseInsensitive,
  relativePathUnder as relativePathUnderFn,
} from '../base/path.js'
import { toDisposable, type IDisposable } from '../base/lifecycle.js'
import { ResourceMap, ResourceSet } from '../base/resourceMap.js'
import type { HostPlatform } from '../host/hostService.js'

export interface IUriIdentityService {
  readonly _serviceBrand: undefined

  /** The bound host platform. Exposed for the rare caller that still needs the raw value. */
  readonly platform: HostPlatform

  /** Whether two URIs address the same resource under the platform's case policy. */
  isEqual(a: URI | undefined, b: URI | undefined): boolean

  /** Whether `resource` equals or is nested under `parent`. */
  isEqualOrParent(resource: URI | undefined, parent: URI | undefined): boolean

  /** Stable identity key for a resource; use with {@link createResourceMap}. */
  getComparisonKey(resource: URI): string

  /**
   * Declares that paths on `scheme`'s filesystem compare case-sensitively (or
   * not), overriding the host platform for that scheme. A filesystem provider
   * calls this at registration time with its
   * `IFileSystemProviderCapabilities.pathCaseSensitive`. Disposing restores the
   * host-platform default.
   */
  registerSchemeCaseSensitivity(scheme: string, caseSensitive: boolean): IDisposable

  /** Whether `resource`'s filesystem compares paths case-sensitively. */
  isCaseSensitive(resource: URI): boolean

  /** Platform-aware equality of two absolute filesystem path strings. */
  arePathsEqual(a: string | undefined, b: string | undefined): boolean

  /** Stable identity key for an absolute filesystem path string (for `Map`/`Set`). */
  getPathComparisonKey(path: string): string

  /** Relative path of `child` under `parent` (`''` when equal), or null. */
  relativePathUnder(parent: string, child: string): string | null

  /**
   * URI-level relative path, mirroring VSCode's `ExtUri.relativePath`: `to`
   * must share `from`'s scheme and authority, and be equal to or nested under
   * `from` ('' when equal). Returns null otherwise — callers fall back to a
   * full path label. Case sensitivity follows `from`'s registered policy.
   */
  relativePath(from: URI, to: URI): string | null

  /** A {@link ResourceMap} pre-wired with this service's comparison key. */
  createResourceMap<V>(): ResourceMap<V>

  /** A {@link ResourceSet} pre-wired with this service's comparison key. */
  createResourceSet(): ResourceSet
}

export const IUriIdentityService = createDecorator<IUriIdentityService>('uriIdentityService')

export class UriIdentityService implements IUriIdentityService {
  declare readonly _serviceBrand: undefined

  private readonly _schemeCaseSensitivity = new Map<string, boolean>()

  /** Bound once so every comparison below sees the same per-scheme registry. */
  private readonly _caseSensitivity: CaseSensitivityResolver = (resource) =>
    this._schemeCaseSensitivity.get(resource.scheme)

  constructor(readonly platform: HostPlatform) {}

  registerSchemeCaseSensitivity(scheme: string, caseSensitive: boolean): IDisposable {
    this._schemeCaseSensitivity.set(scheme, caseSensitive)
    return toDisposable(() => {
      if (this._schemeCaseSensitivity.get(scheme) === caseSensitive) {
        this._schemeCaseSensitivity.delete(scheme)
      }
    })
  }

  isCaseSensitive(resource: URI): boolean {
    return this._schemeCaseSensitivity.get(resource.scheme) ?? !isCaseInsensitive(this.platform)
  }

  isEqual(a: URI | undefined, b: URI | undefined): boolean {
    return isEqualResource(a, b, this.platform, this._caseSensitivity)
  }

  isEqualOrParent(resource: URI | undefined, parent: URI | undefined): boolean {
    return isEqualOrParentResource(resource, parent, this.platform, this._caseSensitivity)
  }

  getComparisonKey(resource: URI): string {
    return getResourceComparisonKey(resource, this.platform, this._caseSensitivity)
  }

  arePathsEqual(a: string | undefined, b: string | undefined): boolean {
    return arePathsEqualFn(a, b, this.platform)
  }

  getPathComparisonKey(path: string): string {
    return getPathComparisonKeyFn(path, this.platform)
  }

  relativePathUnder(parent: string, child: string): string | null {
    return relativePathUnderFn(parent, child, this.platform)
  }

  relativePath(from: URI, to: URI): string | null {
    if (from.scheme !== to.scheme || from.authority !== to.authority) return null
    const platform: HostPlatform = this.isCaseSensitive(from) ? 'linux' : 'win32'
    return relativePathUnderFn(from.path, to.path, platform)
  }

  createResourceMap<V>(): ResourceMap<V> {
    return new ResourceMap<V>((resource) => this.getComparisonKey(resource))
  }

  createResourceSet(): ResourceSet {
    return new ResourceSet((resource) => this.getComparisonKey(resource))
  }
}
