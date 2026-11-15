/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared trigger runtime types that several scheduler modules consume without
 *  depending on each other (kept out of triggerMainService to avoid import cycles).
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'
import type { TriggerConfig } from '../../../shared/triggers/types.js'

/** A trigger config resolved against the workspace entry that owns it. */
export interface RoutedTrigger extends TriggerConfig {
  /** Composite workspace + id; the only identity used for state and the public API. */
  readonly key: string
  /** Workspace URI string (`file:///…` / `remote-ssh://…`). */
  readonly workspace: string
  readonly workspaceUri: URI
  /** Fingerprint of the bare config; confirmations bind to this. */
  readonly fingerprint: string
}
