/*---------------------------------------------------------------------------------------------
 *  Phone-uploaded non-image attachments. Each becomes an ACP `resource_link`
 *  carrying the PC-local `file:` URI, matching how desktop @-mentions hand files
 *  to the agent. A `_meta.mobileAttachment` stamp lets the mobile projection
 *  render a name/size card without re-reading the block's target.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk'
import {
  MAX_ATTACHMENT_ID_LENGTH,
  MAX_ATTACHMENT_MIME_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_FILE_ATTACHMENT_BYTES,
  type MobileMessageAttachment,
} from '@universe-editor/mobile-protocol'

export const MOBILE_ATTACHMENT_META_KEY = 'mobileAttachment'

export interface PromptFileAttachment {
  /** Upload id, also used as the React key within one prompt. */
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly byteSize: number
  /** `file:` URI of the uploaded copy on this PC. */
  readonly uri: string
}

export function composeFileAttachmentBlocks(
  files: readonly PromptFileAttachment[],
): readonly ContentBlock[] {
  return files.map((file) => ({
    type: 'resource_link',
    uri: file.uri,
    name: file.name,
    ...(file.mimeType !== '' ? { mimeType: file.mimeType } : {}),
    size: file.byteSize,
    _meta: {
      [MOBILE_ATTACHMENT_META_KEY]: {
        id: file.id,
        kind: 'file',
        name: file.name,
        ...(file.mimeType !== '' ? { mimeType: file.mimeType } : {}),
        size: file.byteSize,
      } satisfies MobileMessageAttachment,
    },
  }))
}

/** Read and validate the mobile attachment stamp on a content block. */
export function readMobileAttachmentMeta(block: ContentBlock): MobileMessageAttachment | undefined {
  const meta = block._meta
  if (typeof meta !== 'object' || meta === null) return undefined
  const raw = (meta as Record<string, unknown>)[MOBILE_ATTACHMENT_META_KEY]
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const id = value['id']
  const kind = value['kind']
  const name = value['name']
  const mimeType = value['mimeType']
  const size = value['size']
  if (typeof id !== 'string' || id === '' || id.length > MAX_ATTACHMENT_ID_LENGTH) return undefined
  if (kind !== 'image' && kind !== 'file') return undefined
  if (typeof name !== 'string' || name === '' || name.length > MAX_ATTACHMENT_NAME_LENGTH) {
    return undefined
  }
  if (
    mimeType !== undefined &&
    (typeof mimeType !== 'string' || mimeType.length > MAX_ATTACHMENT_MIME_LENGTH)
  ) {
    return undefined
  }
  if (
    typeof size !== 'number' ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > MAX_FILE_ATTACHMENT_BYTES
  ) {
    return undefined
  }
  return {
    id,
    kind,
    name,
    ...(typeof mimeType === 'string' && mimeType !== '' ? { mimeType } : {}),
    size,
  }
}
