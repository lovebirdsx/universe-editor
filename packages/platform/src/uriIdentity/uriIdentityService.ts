/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IUriIdentityService (platform/uriIdentity).
 *
 *  The single entry point for resource / path comparison. It binds the host
 *  platform once (win32/darwin fold case, linux is case-sensitive) so callers
 *  never thread `platform` through by hand and never hand-roll `toLowerCase()` /
 *  `fsPath ===` comparisons.
 *
 *  Unlike VSCode we have no multi-provider filesystem — `IFileService` serves the
 *  single `file:` scheme on one host — so case sensitivity is a per-app constant,
 *  not a per-provider `PathCaseSensitive` capability. This service is the tiny
 *  equivalent: platform in, consistent identity out.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { URI } from '../base/uri.js'
import { getResourceComparisonKey, isEqualResource, isEqualOrParentResource } from '../base/uri.js'
import {
  arePathsEqual as arePathsEqualFn,
  getPathComparisonKey as getPathComparisonKeyFn,
  relativePathUnder as relativePathUnderFn,
} from '../base/path.js'
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

  /** Platform-aware equality of two absolute filesystem path strings. */
  arePathsEqual(a: string | undefined, b: string | undefined): boolean

  /** Stable identity key for an absolute filesystem path string (for `Map`/`Set`). */
  getPathComparisonKey(path: string): string

  /** Relative path of `child` under `parent` (`''` when equal), or null. */
  relativePathUnder(parent: string, child: string): string | null

  /** A {@link ResourceMap} pre-wired with this service's comparison key. */
  createResourceMap<V>(): ResourceMap<V>

  /** A {@link ResourceSet} pre-wired with this service's comparison key. */
  createResourceSet(): ResourceSet
}

export const IUriIdentityService = createDecorator<IUriIdentityService>('uriIdentityService')

export class UriIdentityService implements IUriIdentityService {
  declare readonly _serviceBrand: undefined

  constructor(readonly platform: HostPlatform) {}

  isEqual(a: URI | undefined, b: URI | undefined): boolean {
    return isEqualResource(a, b, this.platform)
  }

  isEqualOrParent(resource: URI | undefined, parent: URI | undefined): boolean {
    return isEqualOrParentResource(resource, parent, this.platform)
  }

  getComparisonKey(resource: URI): string {
    return getResourceComparisonKey(resource, this.platform)
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

  createResourceMap<V>(): ResourceMap<V> {
    return new ResourceMap<V>((resource) => this.getComparisonKey(resource))
  }

  createResourceSet(): ResourceSet {
    return new ResourceSet((resource) => this.getComparisonKey(resource))
  }
}
