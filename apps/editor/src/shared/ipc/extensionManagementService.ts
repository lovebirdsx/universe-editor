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
import type {
  ExtensionInstallSource,
  IExtensionGalleryMetadata,
} from '@universe-editor/extensions-common'
import type { IGalleryExtension } from './extensionGalleryService.js'

// Wire-neutral install-source + gallery-metadata types now live in
// `@universe-editor/extensions-common` (shared with the node-services install
// engine); re-exported here so existing IPC import surfaces don't move.
export type {
  ExtensionInstallSource,
  IExtensionGalleryMetadata,
} from '@universe-editor/extensions-common'

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
  /**
   * False when the extension's `engines.universe` range is incompatible with the
   * host API version (computed by the management service for the UI list — the
   * host independently refuses to activate such an extension). Absent = compatible.
   */
  readonly isVersionCompatible?: boolean
  /** Reason for `isVersionCompatible: false`, e.g. `requires universe >=99.0.0, host is 0.13.0`. */
  readonly validationMessage?: string
}

export interface IExtensionManagementService {
  readonly _serviceBrand: undefined

  /**
   * Fires whenever the installed set changes (install / uninstall). The renderer
   * refreshes its UI and triggers a restricted-host rescan so the change takes
   * effect.
   */
  readonly onDidChangeExtensions: Event<void>

  /**
   * Every extension currently registered in `extensions.json` (and on disk).
   * With `authority`, lists the remote host's user extensions instead (icons
   * resolve via {@link getLocalIcon}, `location` is empty on the remote).
   */
  getInstalled(authority?: string): Promise<ILocalExtension[]>

  /**
   * The bundled built-in extensions (git / typescript / markdown / …). Scanned
   * from the built-in extensions directory, not `extensions.json`. Surfaced to
   * the Extensions UI so built-ins can be enabled / disabled like any other.
   * `source` is `'builtin'`; they can never be uninstalled.
   */
  listBuiltinExtensions(): Promise<ILocalExtension[]>

  /**
   * Extensions loaded from `--extension-development-path` roots. Surfaced to the
   * Extensions UI with `source: 'development'` so they show a "development" badge
   * and get no uninstall/disable affordances (they are not in `extensions.json`,
   * so neither operation has meaning for them). Empty outside ext-dev mode.
   */
  listDevExtensions(): Promise<ILocalExtension[]>

  /**
   * Install from the marketplace: download the VSIX, verify its manifest matches
   * the gallery metadata (publisher/name/version — anti-poisoning) and its bytes
   * against the marketplace Ed25519 signature (fail-closed: unsigned or invalid
   * packages are refused), then install it. Refuses extensions the control
   * manifest marks malicious. Carries the gallery metadata into the installed
   * record. With `authority`, downloads + verifies locally then uploads the
   * VSIX to the remote host for install.
   */
  installFromGallery(extension: IGalleryExtension, authority?: string): Promise<ILocalExtension>

  /**
   * Install from a local `.vsix` path: read + validate the manifest, check engine
   * compatibility, extract into `<userExtensions>/<id>-<version>` atomically, and
   * register it. Idempotent: re-installing the same id+version returns the
   * existing entry without error. With `authority`, uploads the VSIX chunks to
   * the remote host and installs it there.
   */
  installVSIX(vsixPath: string, authority?: string): Promise<ILocalExtension>

  /**
   * Uninstall by identifier; removes the folder (or marks it obsolete if busy).
   * With `authority`, uninstalls from the remote host's user extensions.
   */
  uninstall(identifier: string, authority?: string): Promise<void>

  /**
   * The disabled identifiers (persisted in `extensions.json` enablement map).
   * With `authority`, the remote host's disabled set.
   */
  getDisabledIds(authority?: string): Promise<string[]>

  /**
   * Read a locally-installed / built-in extension's own icon (the manifest `icon`
   * path, relative to its folder) as a `data:` URL. Returns '' when it declares
   * no icon or the file can't be read. The renderer CSP blocks `file://`, so main
   * reads + encodes it — same pattern as gallery icons. With `authority`, fetches
   * the remote extension's icon from the remote host.
   */
  getLocalIcon(identifier: string, authority?: string): Promise<string>

  /**
   * Enable / disable an installed extension. Persists to `extensions.json` and
   * fires onDidChangeExtensions so the host re-scans (a disabled extension is
   * filtered out of the scan — it stops running entirely). With `authority`,
   * persists enablement on the remote host.
   */
  setEnablement(identifier: string, enabled: boolean, authority?: string): Promise<void>

  /**
   * On startup: disable any installed extension the control manifest now marks
   * malicious, returning the ids newly disabled (for a user notification). This
   * is the "remote kill switch" for an extension found malicious after install.
   */
  quarantineMalicious(): Promise<string[]>

  /**
   * Check the marketplace for newer versions of installed gallery-sourced
   * extensions. Returns the ones with an available update. With `authority`,
   * checks the remote host's installed set against the local marketplace.
   */
  checkForUpdates(authority?: string): Promise<IExtensionUpdate[]>

  /** Install the newer version for a pending update (remote when `authority` set). */
  updateExtension(update: IExtensionUpdate, authority?: string): Promise<ILocalExtension>
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
