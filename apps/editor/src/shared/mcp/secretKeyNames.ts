/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The one list of key names that mark a neighbouring value as a credential.
 *
 *  Two processes need the same answer to "is this a secret?": main masks stderr and
 *  target dumps before they reach a log line (`mcpTargetSafety`), the renderer masks
 *  the confirm dialog and the panel's history (`mcpDebugModel`). They used to keep a
 *  copy each and had already drifted (`auth` was masked on one side only) — which is
 *  the kind of bug that only shows up when a token lands in a chat panel.
 *
 *  Deliberately broad: `oauth`, `authorizeUrl`, `max_tokens` are collateral damage,
 *  and a false positive only costs a masked log line.
 *--------------------------------------------------------------------------------------------*/

export const MCP_SECRET_KEY_SOURCE =
  'pass(?:word|phrase)?|secret|token|api[-_]?key|authorization|auth|cookie|credential|bearer'
