/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract of the remote `extensionManagement` channel (RemoteChannels.
 *  ExtensionManagement): user-extension distribution on a remote host. The
 *  editor's main process is the client, the remote server implements it against
 *  the shared install engine (extensionInstallEngine.ts).
 *
 *  Design invariants:
 *   - The vsix is downloaded AND signature-verified on the CLIENT (the server
 *     has no gallery/network stack); bytes are streamed up in sequential
 *     `uploadChunk` calls (≤ 1 MiB each — the tunnel codec carries Uint8Array
 *     as raw attachments) and installed from the server-side temp file.
 *   - Engine compatibility (`engines.universe`) is validated on the client
 *     before upload; `installUploaded` re-checks only identifier/version
 *     against `expected` to catch corrupted/mixed-up uploads.
 *   - DTOs carry no server paths: extension locations stay server-private,
 *     icons travel as `data:` URLs.
 *--------------------------------------------------------------------------------------------*/

import type {
  ExtensionInstallSource,
  IExtensionGalleryMetadata,
  IExtensionManifest,
} from '@universe-editor/extensions-common'

/** A user extension installed on the remote host, as tracked in its extensions.json. */
export interface IRemoteInstalledExtension {
  /** `<publisher>.<name>` when a publisher is present, else `<name>`. */
  readonly identifier: string
  readonly version: string
  /** Manifest localized with the locale passed to `listInstalled`/`installUploaded`. */
  readonly manifest: IExtensionManifest
  readonly source: ExtensionInstallSource
  readonly installedAt: number
  readonly galleryMetadata?: IExtensionGalleryMetadata
}

export interface IRemoteInstallOptions {
  readonly source: 'vsix' | 'gallery'
  readonly galleryMetadata?: IExtensionGalleryMetadata
  /** Display locale for manifest NLS in the returned DTO. */
  readonly locale?: string
}

export interface IRemoteExtensionManagementService {
  /** Extensions installed in the server's user-extensions directory. */
  listInstalled(locale?: string | null): Promise<IRemoteInstalledExtension[]>

  /** Open a chunked vsix upload; returns an opaque upload id. */
  uploadBegin(): Promise<string>

  /** Append one chunk (≤ 1 MiB); calls must be sequential per upload id. */
  uploadChunk(uploadId: string, chunk: Uint8Array): Promise<void>

  /** Drop an in-flight upload and its temp file. */
  uploadAbort(uploadId: string): Promise<void>

  /**
   * Install the uploaded vsix into the user-extensions directory. Rejects when
   * the uploaded manifest does not match `expected` (corrupted upload guard).
   * Consumes the upload id regardless of outcome.
   */
  installUploaded(
    uploadId: string,
    expected: { readonly identifier: string; readonly version: string },
    options: IRemoteInstallOptions,
  ): Promise<IRemoteInstalledExtension>

  /** Uninstall by identifier. Returns false when it was not installed. */
  uninstall(identifier: string): Promise<boolean>

  /** Disabled identifiers persisted in the server-side extensions.json. */
  getDisabledIds(): Promise<string[]>

  /** Enable/disable an installed extension in the server-side extensions.json. */
  setEnablement(identifier: string, enabled: boolean): Promise<void>

  /**
   * The extension's own icon (manifest `icon` within its folder) as a `data:`
   * URL, '' when absent/unreadable — the renderer CSP blocks remote files.
   */
  getIcon(identifier: string): Promise<string>
}
