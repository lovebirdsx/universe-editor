/*---------------------------------------------------------------------------------------------
 *  Orchestrates "copy one message as an image": temporarily expands a folded
 *  card, waits for its body, releases the user-message clamp, rasterizes it, and
 *  hands the PNG base64 to the host clipboard. Split from the Action2 so the
 *  sequence (and its restoration guarantees) is unit-testable without DI.
 *--------------------------------------------------------------------------------------------*/

import { blobToBase64 } from '../../services/acp/promptImage.js'
import {
  MessageImageTooLargeError,
  MessageImageUnavailableError,
  renderMessageImage,
} from './messageImage.js'
import { expandCollapsedUserBodies, waitForSlotBody } from './slotCaptureTarget.js'

export type MessageImageCopyResult =
  | { kind: 'ok' }
  | { kind: 'unavailable' }
  | { kind: 'too-large' }
  | { kind: 'failed'; error: unknown }

export interface CopyMessageAsImageOptions {
  readonly container: HTMLElement
  readonly slotKey: string
  /** Temporarily expands a folded card; returns the exact restore callback. */
  readonly expandSlotTemporarily: (key: string) => () => void
  readonly writeImage: (base64: string) => Promise<void>
}

export async function copyMessageAsImage(
  options: CopyMessageAsImageOptions,
): Promise<MessageImageCopyResult> {
  const restoreCollapse = options.expandSlotTemporarily(options.slotKey)
  let restoreUserClamp: (() => void) | undefined
  try {
    const body = await waitForSlotBody(options.container, options.slotKey)
    if (body === undefined) return { kind: 'unavailable' }
    restoreUserClamp = expandCollapsedUserBodies(body)
    const blob = await renderMessageImage(body)
    const base64 = await blobToBase64(blob)
    await options.writeImage(base64)
    return { kind: 'ok' }
  } catch (error) {
    if (error instanceof MessageImageTooLargeError) return { kind: 'too-large' }
    if (error instanceof MessageImageUnavailableError) return { kind: 'unavailable' }
    console.warn('[acp] copy message image failed', error)
    return { kind: 'failed', error }
  } finally {
    restoreUserClamp?.()
    restoreCollapse()
  }
}
