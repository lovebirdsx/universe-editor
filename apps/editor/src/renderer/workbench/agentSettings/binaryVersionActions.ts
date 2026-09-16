/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  binaryVersionActions — shared button-visibility derivation for the two binary
 *  panels (claude/BinaryPanel.tsx and codex/CodexBinaryPanel.tsx): which of
 *  download-bundled / revert-to-bundled / get-latest to show for a given
 *  bundled/installed/latest version triple, and what each button's state is for a
 *  given target version (downloading right now, already on disk).
 *--------------------------------------------------------------------------------------------*/

export interface BinaryVersionActions {
  showDownloadBundled: boolean
  showRevertToBundled: boolean
  showLatest: boolean
}

export function computeBinaryVersionActions(info: {
  bundledVersion: string
  installedVersion: string | null
  latestVersion: string | null
}): BinaryVersionActions {
  const { bundledVersion, installedVersion, latestVersion } = info
  return {
    // Offer the bundled version when nothing is installed yet.
    showDownloadBundled: installedVersion === null,
    // Offer a way back to the bundled version once something else is installed.
    showRevertToBundled: installedVersion !== null && installedVersion !== bundledVersion,
    // Offer the latest version whenever it differs from what's installed and from
    // the bundled one (when bundled === latest a single button is enough).
    showLatest:
      latestVersion !== null &&
      latestVersion !== bundledVersion &&
      installedVersion !== latestVersion,
  }
}

export interface BinaryActionState {
  readonly version: string
  /**
   * A download for exactly this version is in flight → the panel swaps the button
   * for a progress row. The store de-dupes by version, so the button would be a
   * no-op anyway; hiding it is what tells the user the click already landed.
   */
  readonly downloading: boolean
  /** The binary is already extracted on disk → switching to it needs no network. */
  readonly onDisk: boolean
}

/**
 * State of the action button targeting `version`. `downloads` MUST be the live set
 * from the service's `onDidChangeDownload` — passing the `getVersionInfo` snapshot
 * instead leaves the button on screen next to the progress row the moment a click
 * starts a download (the snapshot predates it). The snapshot serves only to restore
 * the state a panel missed while unmounted.
 */
export function deriveBinaryActionState(
  version: string,
  info: {
    readonly downloadedVersions: readonly string[]
    readonly downloads: readonly { readonly version: string }[]
  },
): BinaryActionState {
  return {
    version,
    downloading: info.downloads.some((d) => d.version === version),
    onDisk: info.downloadedVersions.includes(version),
  }
}
