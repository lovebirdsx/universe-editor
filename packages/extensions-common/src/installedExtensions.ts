/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire-neutral types for the installed-extensions manifest (`extensions.json` on
 *  disk). Shared by the main process's extension-management service, the
 *  node-services install engine, and (later) the remote server — none of which
 *  may depend on the editor's `shared/ipc` DTO layer. The IPC-specific shapes
 *  (`ILocalExtension`, the service interface) stay in the editor and build on
 *  these.
 *--------------------------------------------------------------------------------------------*/

/** How an installed extension entered the user extensions directory. */
export type ExtensionInstallSource = 'vsix' | 'gallery' | 'builtin' | 'development'

/** Marketplace metadata carried forward for gallery-sourced installs (UI + updates). */
export interface IExtensionGalleryMetadata {
  readonly publisherDisplayName?: string
  readonly installCount?: number
  /** The gallery `vsixUrl` at install time — lets update-check re-download. */
  readonly vsixUrl?: string
  /** sha256 of the installed VSIX, as advertised + verified at install time. */
  readonly vsixHash?: string
}

/** One entry in `extensions.json` `installed[]`. */
export interface IInstalledExtensionRecord {
  readonly identifier: string
  readonly version: string
  /** Folder name relative to the extensions directory. */
  readonly location: string
  readonly source: ExtensionInstallSource
  readonly installedAt: number
  /** Present for gallery-sourced installs. */
  readonly galleryMetadata?: IExtensionGalleryMetadata
}
