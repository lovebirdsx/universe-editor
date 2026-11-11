/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure adapter between the PC in-memory draft and the draft the mobile gateway
 *  transports. Image/file bytes never enter this projection: the wire carries
 *  ids + metadata only, and the renderer keeps its own `PromptImage` /
 *  `PromptFileAttachment` objects.
 *--------------------------------------------------------------------------------------------*/

import type { MobileBridgeDraft } from '../../../shared/ipc/mobileGatewayService.js'
import type { AcpPromptDraft } from '../acp/session/acpPromptDraftCache.js'

/** Project a PC draft for the gateway; `undefined` means "nothing to sync". */
export function toBridgeDraft(draft: AcpPromptDraft): MobileBridgeDraft | undefined {
  const text = draft.text
  const images = (draft.images ?? []).map((image) => ({
    id: image.id,
    source: 'pc' as const,
    mimeType: image.mimeType,
    byteSize: image.byteSize,
    ...(image.name !== undefined && image.name !== '' ? { name: image.name } : {}),
  }))
  const files = (draft.files ?? []).map((file) => ({
    id: file.id,
    name: file.name,
    ...(file.mimeType !== '' ? { mimeType: file.mimeType } : {}),
    byteSize: file.byteSize,
  }))
  const refs = (draft.refs ?? []).map((placed) => ({
    id: placed.ref.id,
    kind: placed.ref.kind,
    label: placed.ref.label,
    start: placed.start,
    end: placed.end,
  }))
  const contexts = (draft.contexts ?? []).map((context) => ({
    relPath: context.relPath,
    startLine: context.startLine,
    endLine: context.endLine,
    ...(context.languageId !== undefined && context.languageId !== ''
      ? { languageId: context.languageId }
      : {}),
  }))
  if (
    text === '' &&
    images.length === 0 &&
    files.length === 0 &&
    refs.length === 0 &&
    contexts.length === 0
  ) {
    return undefined
  }
  return {
    text,
    images,
    ...(files.length > 0 ? { files } : {}),
    ...(refs.length > 0 ? { refs } : {}),
    ...(contexts.length > 0 ? { contexts } : {}),
  }
}

/**
 * Apply a gateway draft to the PC cache. Text/attachments are shared; refs
 * survive only while the text is unchanged (their ranges point into the old
 * buffer); contexts always survive. The caret is local UI state: keep this
 * window's position (clamped) so a phone edit never moves the PC cursor.
 * Attachments are matched by id so a draft authored on the phone cannot
 * fabricate bytes the renderer has not received yet.
 */
export function mergeBridgeDraft(
  current: AcpPromptDraft | undefined,
  incoming: MobileBridgeDraft,
): AcpPromptDraft | undefined {
  const textChanged = current?.text !== incoming.text
  const refs = textChanged ? [] : (current?.refs ?? [])
  const contexts = current?.contexts ?? []
  // The phone echoes the PC-pasted pictures it still wants in the draft, so
  // omission is a deletion. Bytes are matched by id: the phone can describe an
  // attachment long before the renderer has received (or can trust) its bytes.
  const images = incoming.images.flatMap((ref) => {
    const existing = current?.images?.find((image) => image.id === ref.id)
    return existing === undefined ? [] : [existing]
  })
  const files = (incoming.files ?? []).flatMap((ref) => {
    const existing = current?.files?.find((file) => file.id === ref.id)
    return existing === undefined ? [] : [existing]
  })
  if (
    incoming.text === '' &&
    images.length === 0 &&
    files.length === 0 &&
    refs.length === 0 &&
    contexts.length === 0
  ) {
    return undefined
  }
  // A remote text replacement keeps the local caret; an empty local buffer has
  // no meaningful position, so the next mount starts typing at the end.
  const localCaret = current?.caret
  const caret =
    localCaret === undefined || current?.text === ''
      ? incoming.text.length
      : Math.min(localCaret, incoming.text.length)
  return {
    text: incoming.text,
    caret,
    ...(refs.length > 0 ? { refs } : {}),
    ...(contexts.length > 0 ? { contexts } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
  }
}
