/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  InteractionPerformanceInput — a stateless virtual EditorInput. The editor
 *  renders a live snapshot from IInteractionPerfService on mount/refresh, so
 *  the input carries no payload and a fixed resource makes it a singleton tab.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

export class InteractionPerformanceInput extends EditorInput {
  static readonly TYPE_ID = 'interactionPerformance'

  override get typeId(): string {
    return InteractionPerformanceInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'interaction-performance', path: '/' })
  }

  override get id(): string {
    return 'interaction-performance'
  }

  override getName(): string {
    return 'Interaction Performance'
  }

  override serialize(): Record<string, never> {
    return {}
  }

  static deserialize(): InteractionPerformanceInput {
    return new InteractionPerformanceInput()
  }
}
