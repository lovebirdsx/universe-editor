/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared channel-name ordering for the Output view toolbar dropdown and the
 *  "Show Output Channels..." quick pick: the aggregated 'All' channel pinned
 *  first, everything else alphabetical.
 *--------------------------------------------------------------------------------------------*/

export function sortOutputChannelNames(names: readonly string[], pinned = 'All'): string[] {
  return [...names].sort((a, b) => {
    if (a === pinned) return -1
    if (b === pinned) return 1
    return a.localeCompare(b)
  })
}
