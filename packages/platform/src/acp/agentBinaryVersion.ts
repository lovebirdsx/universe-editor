/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Which version a managed agent-binary tree runs. Declared here because all
 *  three layers must agree on the literal values: the download core
 *  (node-services, local main + remote server), the agent-binary remote channel,
 *  and the editor's renderer-facing wire contracts.
 *--------------------------------------------------------------------------------------------*/

/**
 * `'pinned'` — the tree always runs the flavor's pin (the version this build was
 * made against) and the `.active` pointer is ignored, so a version picked by hand
 * can never survive an editor upgrade; seeing the pin on disk still reconciles the
 * pointer to it, so unlocking later resumes the pin rather than a pre-lock pick.
 * `'manual'` — `.active` wins: the version a user picked, falling back to the pin
 * when nothing was ever picked.
 */
export type AgentBinaryVersionPolicy = 'pinned' | 'manual'
