/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Builds the temporary URIs for a diff view's two Monaco models. Each side keeps
 *  the original resource's path untouched and only swaps the scheme, so the URI
 *  round-trips cleanly through Monaco's language workers. Concatenating the full
 *  `file://…` string into the path instead (`diff-modified:file:///D:/…`) yields a
 *  malformed URI that the TypeScript worker rejects with "Could not find source
 *  file" when diffing `.ts`/`.js` resources.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'

export type DiffSide = 'original' | 'modified'

const SCHEME: Record<DiffSide, string> = {
  original: 'diff-original',
  modified: 'diff-modified',
}

export function diffModelUri(originalUri: URI, side: DiffSide): URI {
  return originalUri.with({ scheme: SCHEME[side] })
}
