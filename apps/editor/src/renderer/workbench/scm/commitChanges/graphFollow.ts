/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  graphFollow — silent follow of a graph selection into the Commit Changes
 *  sidebar view, shared by the git and perforce graph editors. A programmatic
 *  reveal (Open in Graph from blame / timeline / the Commit Changes toolbar)
 *  pushes the revealed commit's changes into the view with `silent: true` —
 *  the content tracks the graph without opening the SCM container, expanding
 *  the view or moving focus. Deliberate row clicks keep the non-silent bridge.
 *--------------------------------------------------------------------------------------------*/

import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'
import { commitChangesViewState } from './viewState.js'

/** Gate for the follow: only sync when the view already shows something (the
 *  cheap stand-in for "the user is engaged with this view" — precise view
 *  visibility isn't worth the plumbing) and isn't already showing this exact
 *  ref, so re-selecting the same commit never refetches. */
export function shouldFollowGraphSelection(providerId: string, commitRef: string): boolean {
  const current = commitChangesViewState.payload.get()
  return current !== null && (current.providerId !== providerId || current.commitRef !== commitRef)
}

export interface CommitChangesFollowerOptions {
  providerId: string
  /** Fetch + assemble the payload for a graph commit; null → leave the view as is. */
  build: (commitRef: string) => Promise<ShowCommitChangesPayload | null>
  /** Push the payload through the `_workbench.showCommitChanges` bridge. */
  apply: (payload: ShowCommitChangesPayload) => Promise<unknown>
  /** Shared latest-wins sequence: pass the editor's click-path counter so a
   *  deliberate click supersedes a follow still in flight (and vice versa),
   *  never landing stale content over a newer selection. */
  seq?: { current: number }
}

/** Returns the follow entry point for a graph editor: call it with the commit
 *  a reveal just selected. The update goes out with `silent: true`. The latest
 *  call wins, so rapid successive reveals can't land out of order, and a ref
 *  already in flight (or already shown) is never fetched twice. */
export function createCommitChangesFollower(
  options: CommitChangesFollowerOptions,
): (commitRef: string) => void {
  const seqState = options.seq ?? { current: 0 }
  let inFlight: string | null = null
  return (commitRef) => {
    if (commitRef === inFlight || !shouldFollowGraphSelection(options.providerId, commitRef)) {
      return
    }
    const mySeq = ++seqState.current
    inFlight = commitRef
    void (async () => {
      const payload = await options.build(commitRef)
      if (mySeq === seqState.current) inFlight = null
      if (payload === null || mySeq !== seqState.current) return
      await options.apply({ ...payload, silent: true })
    })()
  }
}
