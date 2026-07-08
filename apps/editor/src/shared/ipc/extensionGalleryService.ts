/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for the extension marketplace (gallery). Lives in the
 *  main process: it does the `/extensionquery` network calls, VSIX download +
 *  caching, and control-manifest fetch. The renderer drives it via ProxyChannel.
 *  Mirrors VSCode's `IExtensionGalleryService`. Pure "get" side — installing what
 *  it downloads is `IExtensionManagementService`'s job.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type {
  IGalleryExtension,
  IGalleryQueryResult,
  IQueryOptions,
} from '@universe-editor/extension-gallery'

export type { IGalleryExtension, IGalleryQueryResult, IQueryOptions }

/**
 * Marketplace control list (malicious / deprecated extensions). Fetched + cached
 * by the gallery service; consulted by the management service before install and
 * on startup. MVP-simplified vs VSCode's full control manifest.
 */
export interface IExtensionControlManifest {
  /** `publisher.name` ids that must be refused on install + disabled on startup. */
  readonly malicious: readonly string[]
  /** Deprecated ids → migration hint. */
  readonly deprecated: Readonly<Record<string, IExtensionDeprecation>>
}

export interface IExtensionDeprecation {
  readonly reason?: string
  /** `publisher.name` of the replacement extension, if any. */
  readonly migrateTo?: string
}

export interface IExtensionGalleryService {
  readonly _serviceBrand: undefined

  /** Marketplace configured (GALLERY_URL has a value). Off ⇒ UI hides search. */
  isEnabled(): Promise<boolean>

  /** Search the marketplace. Paged, sorted, category-filtered. */
  query(options: IQueryOptions): Promise<IGalleryQueryResult>

  /** Fetch specific extensions by `publisher.name` id (install / update-check). */
  getExtensions(ids: readonly string[]): Promise<IGalleryExtension[]>

  /**
   * Download an extension's VSIX into the on-disk cache and return its local path.
   * Cached by `<publisher>.<name>-<version>.vsix`; a present cache hit is reused.
   */
  download(extension: IGalleryExtension): Promise<string>

  /** README text for the detail page (empty string if none / unavailable). */
  getReadme(extension: IGalleryExtension): Promise<string>

  /**
   * Fetch an extension's icon and return it as a `data:` URL the renderer can put
   * straight into an <img> (the CSP allows `data:` but not remote `https:` images).
   * Downloaded + cached in the main process. Empty string if there's no icon or
   * it can't be fetched — callers fall back to a generic icon.
   */
  getIcon(extension: IGalleryExtension): Promise<string>

  /** The (cached) control manifest. Empty lists when no marketplace / offline. */
  getControlManifest(): Promise<IExtensionControlManifest>
}

export const IExtensionGalleryService =
  createDecorator<IExtensionGalleryService>('extensionGalleryService')
