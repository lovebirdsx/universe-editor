/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for extension management (install / uninstall / list of
 *  user-installed extensions). Mirrors VSCode's `IExtensionManagementService`.
 *  Lives in the main process because it does filesystem writes + zip extraction;
 *  the renderer drives it via ProxyChannel. Phase A scope: local `.vsix` install,
 *  uninstall, and listing. Gallery download / enablement / updates come later.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'
import type { IExtensionManifest } from '@universe-editor/extensions-common'
import type { IGalleryExtension } from './extensionGalleryService.js'

/** How an installed extension entered the user extensions directory. */
export type ExtensionInstallSource = 'vsix' | 'gallery' | 'builtin'

/** Marketplace metadata carried forward for gallery-sourced installs (UI + updates). */
export interface IExtensionGalleryMetadata {
  readonly publisherDisplayName?: string
  readonly installCount?: number
  /** The gallery `vsixUrl` at install time — lets update-check re-download. */
  readonly vsixUrl?: string
}

/** A user-installed extension, as tracked in `extensions.json` + on disk. */
export interface ILocalExtension {
  /** `<publisher>.<name>` when a publisher is present, else `<name>`. */
  readonly identifier: string
  readonly manifest: IExtensionManifest
  readonly version: string
  /** Absolute path to the extension's installed folder. */
  readonly location: string
  /** How it was installed. */
  readonly source: ExtensionInstallSource
  /** Epoch millis when installed. */
  readonly installedAt: number
  /** Present for gallery-sourced installs. */
  readonly galleryMetadata?: IExtensionGalleryMetadata
}

export interface IExtensionManagementService {
  readonly _serviceBrand: undefined

  /**
   * Fires whenever the installed set changes (install / uninstall). The renderer
   * refreshes its UI and triggers a restricted-host rescan so the change takes
   * effect.
   */
  readonly onDidChangeExtensions: Event<void>

  /** Every extension currently registered in `extensions.json` (and on disk). */
  getInstalled(): Promise<ILocalExtension[]>

  /**
   * The bundled built-in extensions (git / typescript / markdown / …). Scanned
   * from the built-in extensions directory, not `extensions.json`. Surfaced to
   * the Extensions UI so built-ins can be enabled / disabled like any other.
   * `source` is `'builtin'`; they can never be uninstalled.
   */
  listBuiltinExtensions(): Promise<ILocalExtension[]>

  /**
   * Install from the marketplace: download the VSIX, verify its manifest matches
   * the gallery metadata (publisher/name/version — anti-poisoning), then install
   * it. Refuses extensions the control manifest marks malicious. Carries the
   * gallery metadata into the installed record.
   */
  installFromGallery(extension: IGalleryExtension): Promise<ILocalExtension>

  /**
   * Install from a local `.vsix` path: read + validate the manifest, check engine
   * compatibility, extract into `<userExtensions>/<id>-<version>` atomically, and
   * register it. Idempotent: re-installing the same id+version returns the
   * existing entry without error.
   */
  installVSIX(vsixPath: string): Promise<ILocalExtension>

  /** Uninstall by identifier; removes the folder (or marks it obsolete if busy). */
  uninstall(identifier: string): Promise<void>

  /** The disabled identifiers (persisted in `extensions.json` enablement map). */
  getDisabledIds(): Promise<string[]>

  /**
   * Enable / disable an installed extension. Persists to `extensions.json` and
   * fires onDidChangeExtensions so the host re-scans (a disabled extension is
   * filtered out of the scan — it stops running entirely).
   */
  setEnablement(identifier: string, enabled: boolean): Promise<void>

  /**
   * On startup: disable any installed extension the control manifest now marks
   * malicious, returning the ids newly disabled (for a user notification). This
   * is the "remote kill switch" for an extension found malicious after install.
   */
  quarantineMalicious(): Promise<string[]>

  /**
   * Check the marketplace for newer versions of installed gallery-sourced
   * extensions. Returns the ones with an available update.
   */
  checkForUpdates(): Promise<IExtensionUpdate[]>

  /** Install the newer version for a pending update. */
  updateExtension(update: IExtensionUpdate): Promise<ILocalExtension>
}

/** A pending update: an installed extension with a newer gallery version. */
export interface IExtensionUpdate {
  readonly identifier: string
  readonly fromVersion: string
  readonly toVersion: string
  readonly gallery: IGalleryExtension
}

export const IExtensionManagementService = createDecorator<IExtensionManagementService>(
  'extensionManagementService',
)
