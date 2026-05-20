/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Private helpers shared across the file*Actions modules. Not re-exported.
 *--------------------------------------------------------------------------------------------*/

import { URI, type UriComponents } from '@universe-editor/platform'

export function reviveUri(value: URI | UriComponents | null): URI | null {
  if (!value) return null
  return value instanceof URI ? value : (URI.revive(value) as URI)
}

export interface ITargetArg {
  readonly target?: URI | UriComponents
  readonly isDirectory?: boolean
}
