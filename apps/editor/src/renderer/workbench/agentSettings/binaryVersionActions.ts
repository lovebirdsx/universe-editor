/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  binaryVersionActions — shared button-visibility derivation for the two binary
 *  panels (claude/BinaryPanel.tsx and codex/CodexBinaryPanel.tsx): which of
 *  download-bundled / revert-to-bundled / get-latest to show for a given
 *  bundled/installed/latest version triple.
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
