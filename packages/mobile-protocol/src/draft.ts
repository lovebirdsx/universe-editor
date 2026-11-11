/**
 * Shared prompt-draft state for the PC ↔ phone sync. The WebSocket carries only
 * text, attachment metadata and read-only summaries; image/file bytes travel
 * over the gateway's HTTP APIs. Caret/selection is local UI state on each
 * client and never crosses the wire — applying a remote caret resets the
 * cursor of whichever input is being typed in.
 */

import type { MobileSessionRef } from './frames.js'

export const MOBILE_DRAFT_SOURCES = ['pc', 'mobile'] as const
export type MobileDraftSource = (typeof MOBILE_DRAFT_SOURCES)[number]

/** An image attached to the draft; `id` is a phone upload id or a PC draft image id. */
export interface MobileDraftImageRef {
  readonly id: string
  readonly source: MobileDraftSource
  readonly mimeType: string
  readonly byteSize: number
  readonly name?: string
}

/** A non-image attachment uploaded by the phone. */
export interface MobileDraftFileRef {
  readonly id: string
  readonly name: string
  readonly mimeType?: string
  readonly byteSize: number
}

/** Phone-facing summary; the structured ref itself stays on the PC. */
export interface MobileDraftRefSummary {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly start: number
  readonly end: number
}

/** Phone-facing summary; the selection body stays on the PC. */
export interface MobileDraftContextSummary {
  readonly relPath: string
  readonly startLine: number
  readonly endLine: number
  readonly languageId?: string
}

/** Canonical draft state broadcast by the gateway. `revision` is gateway-assigned. */
export interface MobileDraftState {
  readonly text: string
  readonly images: readonly MobileDraftImageRef[]
  readonly files?: readonly MobileDraftFileRef[]
  readonly refs?: readonly MobileDraftRefSummary[]
  readonly contexts?: readonly MobileDraftContextSummary[]
  readonly revision: number
  readonly updatedAt: number
  readonly source: MobileDraftSource
}

/** Phone → gateway. Phones cannot author refs/contexts. */
export interface MobileDraftPayload {
  readonly text: string
  readonly images: readonly MobileDraftImageRef[]
  readonly files?: readonly MobileDraftFileRef[]
}

/** High-frequency, lossy client frame: no requestId, no command timeout. */
export interface DraftUpdateFrame {
  type: 'draft_update'
  ref: MobileSessionRef
  /** Echoed back to the sender only; the sender treats it as an ack, never as a text write. */
  clientUpdateId: string
  draft: MobileDraftPayload
}
