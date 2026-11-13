/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure decisions for the tray-backed background mode. Kept free of Electron so
 *  every branch is unit-testable; the main service supplies live state.
 *--------------------------------------------------------------------------------------------*/

export interface SupportsLoginItemOptions {
  readonly isPackaged: boolean
  /** Normally process.platform; injectable for tests. */
  readonly platform: NodeJS.Platform
  readonly e2e: boolean
}

/** OS login items exist only in installed Windows/macOS builds, and never under E2E. */
export function supportsLoginItem({
  isPackaged,
  platform,
  e2e,
}: SupportsLoginItemOptions): boolean {
  return isPackaged && !e2e && (platform === 'win32' || platform === 'darwin')
}
