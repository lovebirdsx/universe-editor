/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Platform dispatch for the OS clipboard backend, isolated here so the service
 *  itself stays platform-agnostic and unit-testable with a fake.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'
import type { IOsClipboardBackend } from './osClipboardBackend.js'
import { OsClipboardLinuxBackend } from './osClipboardLinux.js'
import { OsClipboardMacBackend } from './osClipboardMac.js'
import { OsClipboardWindowsBackend } from './osClipboardWindows.js'

export function createOsClipboardBackend(
  platform: NodeJS.Platform,
  tempDir: string,
  logger?: ILogger,
): IOsClipboardBackend {
  switch (platform) {
    case 'win32':
      return new OsClipboardWindowsBackend(tempDir, logger)
    case 'darwin':
      return new OsClipboardMacBackend()
    default:
      return new OsClipboardLinuxBackend()
  }
}
