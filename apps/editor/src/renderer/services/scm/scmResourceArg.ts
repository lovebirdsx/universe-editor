/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  scmResourceArg — the payload SCM resource rows hand to menu commands (the
 *  `scm/resourceState/context` primary arg and each element of its selection).
 *
 *  It lives here rather than in ScmView so the row Actions2 under `actions/` can
 *  read the same shape without importing a React view. Zero imports on purpose:
 *  both sides reference it and neither should be able to form a cycle through it.
 *--------------------------------------------------------------------------------------------*/

/** Payload a file-row command receives: the resource DTO fields the extension host
 *  reads (`resourceUri` / `contextValue`) plus the group id the row lives in, so
 *  group-scoped file commands (unshelve/delete a single shelved file) can resolve
 *  their changelist. Used both for the clicked primary arg and each selected row. */
export interface ScmResourceArg {
  readonly resourceUri: string
  readonly contextValue?: string
  readonly scmResourceGroupId: string
}

/** The host fs-path carried by a row payload; undefined for anything else (a
 *  non-object argument, or a missing / blank `resourceUri`). */
export function scmResourceArgPath(arg: unknown): string | undefined {
  if (typeof arg !== 'object' || arg === null) return undefined
  const resourceUri = (arg as { resourceUri?: unknown }).resourceUri
  return typeof resourceUri === 'string' && resourceUri !== '' ? resourceUri : undefined
}
