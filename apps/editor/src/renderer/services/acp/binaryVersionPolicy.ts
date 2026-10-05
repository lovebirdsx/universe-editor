/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The single reader of `acp.allowManualBinaryVersion`. Every caller that hands a
 *  version policy to the binary services — session spawn, CLI login, the two
 *  Binary panels, idle maintenance — goes through here, so the locked default and
 *  the meaning of the setting cannot drift between them.
 *--------------------------------------------------------------------------------------------*/

import type { AgentBinaryVersionPolicy, IConfigurationService } from '@universe-editor/platform'

/**
 * `'pinned'` unless the user explicitly allowed manual selection: managed
 * binaries then always run the version this build was made against, so a version
 * picked by hand can never outlive an editor upgrade.
 */
export function binaryVersionPolicy(config: IConfigurationService): AgentBinaryVersionPolicy {
  return config.get<boolean>('acp.allowManualBinaryVersion') === true ? 'manual' : 'pinned'
}
