import type {
  InboxDeltaFrame,
  InboxSnapshotFrame,
  MobileSessionRef,
  MobileSessionSummary,
} from '@universe-editor/mobile-protocol'
import { localRefKey } from './refs.js'
import { Store } from './store.js'

export interface InboxState {
  readonly sessions: readonly MobileSessionSummary[]
  readonly seq: number | undefined
  readonly hasSnapshot: boolean
}

export type InboxApplyResult =
  | { readonly status: 'applied' }
  | {
      readonly status: 'resubscribe'
      readonly reason: 'missing_snapshot' | 'seq_regression' | 'seq_gap'
    }

const EMPTY: InboxState = { sessions: [], seq: undefined, hasSnapshot: false }

/**
 * Applies inbox snapshots and deltas. Deltas are only accepted exactly one
 * sequence after the current state; anything else asks the caller to resubscribe
 * (the gateway answers with a fresh snapshot, which resets the sequence).
 */
export class InboxStore extends Store<InboxState> {
  private readonly _byLocalKey = new Map<string, MobileSessionSummary>()

  constructor() {
    super(EMPTY)
  }

  reset(): void {
    this._byLocalKey.clear()
    this.setState(EMPTY)
  }

  applySnapshot(frame: InboxSnapshotFrame): InboxApplyResult {
    this._byLocalKey.clear()
    for (const session of frame.sessions) {
      this._byLocalKey.set(localRefKey(session.ref), session)
    }
    this.setState({ sessions: [...this._byLocalKey.values()], seq: frame.seq, hasSnapshot: true })
    return { status: 'applied' }
  }

  applyDelta(frame: InboxDeltaFrame): InboxApplyResult {
    const state = this.getState()
    if (!state.hasSnapshot || state.seq === undefined) {
      return { status: 'resubscribe', reason: 'missing_snapshot' }
    }
    const expected = state.seq + 1
    if (frame.seq < expected) return { status: 'resubscribe', reason: 'seq_regression' }
    if (frame.seq > expected) return { status: 'resubscribe', reason: 'seq_gap' }

    for (const summary of frame.upserts) {
      this._byLocalKey.set(localRefKey(summary.ref), summary)
    }
    for (const remove of frame.removes) {
      this._remove(remove)
    }
    this.setState({ sessions: [...this._byLocalKey.values()], seq: frame.seq, hasSnapshot: true })
    return { status: 'applied' }
  }

  private _remove(ref: MobileSessionRef): void {
    if (ref.durableId !== undefined) {
      for (const [key, summary] of this._byLocalKey) {
        if (summary.ref.durableId === ref.durableId) {
          this._byLocalKey.delete(key)
          return
        }
      }
    }
    this._byLocalKey.delete(localRefKey(ref))
  }
}
