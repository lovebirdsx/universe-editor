/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side rate mirror: a synchronous view of main's remote rate tables
 *  (fetched lazily), kept fresh via onDidChangeRemote. The hot path (session cost
 *  display) reads this instead of awaiting the promise-based IAiModelService.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { AiRateTable, AiRateTableSnapshot } from '@universe-editor/platform'

export interface IAiRateMirror {
  readonly _serviceBrand: undefined

  /** Synchronously readable mirror of main's rate tables, kept fresh via onDidChangeRemote. */
  getRateTablesSync(): readonly AiRateTableSnapshot[]
  getRatesSync(providerId: string): AiRateTable | undefined
}

export const IAiRateMirror = createDecorator<IAiRateMirror>('aiRateMirror')
