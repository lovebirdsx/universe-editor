/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmReviewEditorInput — a virtual EditorInput for one Swarm review's detail
 *  tab. The review id is baked into `id` / `resource` so each review opens in its
 *  own tab (different review = different id → openEditor never dedupes two reviews
 *  into one tab). See memory `editor-input-identity-isolation`.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

interface ISerializedSwarmReview {
  readonly reviewId: string
}

export class SwarmReviewEditorInput extends EditorInput {
  static readonly TYPE_ID = 'swarmReview'

  constructor(private readonly _reviewId: string) {
    super()
  }

  get reviewId(): string {
    return this._reviewId
  }

  override get typeId(): string {
    return SwarmReviewEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'universe', path: `/swarmReview/${this._reviewId}` })
  }

  override get id(): string {
    return `swarmReview:${this._reviewId}`
  }

  override getName(): string {
    return `Review #${this._reviewId}`
  }

  override serialize(): ISerializedSwarmReview {
    return { reviewId: this._reviewId }
  }

  static deserialize(data: unknown): SwarmReviewEditorInput | null {
    const d = data as ISerializedSwarmReview | null
    if (!d || typeof d.reviewId !== 'string') return null
    return new SwarmReviewEditorInput(d.reviewId)
  }
}
