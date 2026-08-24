/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The three states account usage can be in, resolved once by the panel that owns
 *  the fetch and passed down. Two of them are easy to conflate and must not be:
 *  `loading` is "we are asking", `ready` with an undefined value is "we asked and
 *  the gateway gave us nothing" — the second is the one that must render
 *  "Unavailable" rather than a spinner that never stops, and neither may fall back
 *  to a locally estimated number.
 *--------------------------------------------------------------------------------------------*/

import type { AiAccountUsage } from '@universe-editor/platform'

export type UsageState =
  /** No effective usage source at all — render nothing. */
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  /** `value === undefined` means fetched-but-unavailable, not "not fetched yet". */
  | { readonly kind: 'ready'; readonly value: AiAccountUsage | undefined }
