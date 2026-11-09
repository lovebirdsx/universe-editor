import {
  MAX_ATTACHMENT_ID_LENGTH,
  MAX_ATTACHMENT_MIME_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_FILE_ATTACHMENT_BYTES,
} from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_ATTACHMENT_META_KEY,
  composeFileAttachmentBlocks,
  readMobileAttachmentMeta,
} from '../promptAttachment.js'

const file = {
  id: 'att-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  byteSize: 5,
  uri: 'file:///tmp/attachments/att-1/notes.txt',
}

describe('composeFileAttachmentBlocks', () => {
  it('builds a resource_link with the PC-local file URI and mobile metadata', () => {
    expect(composeFileAttachmentBlocks([file])).toEqual([
      {
        type: 'resource_link',
        uri: file.uri,
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        _meta: {
          [MOBILE_ATTACHMENT_META_KEY]: {
            id: 'att-1',
            kind: 'file',
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 5,
          },
        },
      },
    ])
  })

  it('omits an empty mime type', () => {
    const block = composeFileAttachmentBlocks([{ ...file, mimeType: '' }])[0]
    expect(block).not.toHaveProperty('mimeType')
    expect(block).toMatchObject({ _meta: { mobileAttachment: { id: 'att-1' } } })
  })
})

describe('readMobileAttachmentMeta', () => {
  const block = {
    type: 'resource_link' as const,
    uri: file.uri,
    name: 'notes.txt',
  }

  it('reads valid stamps for both kinds', () => {
    expect(
      readMobileAttachmentMeta({
        ...block,
        _meta: { mobileAttachment: { id: 'a', kind: 'image', name: 'a.png', size: 1 } },
      }),
    ).toEqual({ id: 'a', kind: 'image', name: 'a.png', size: 1 })
  })

  it('ignores missing, malformed or incomplete stamps', () => {
    expect(readMobileAttachmentMeta(block)).toBeUndefined()
    expect(
      readMobileAttachmentMeta({ ...block, _meta: { mobileAttachment: 'nope' } }),
    ).toBeUndefined()
    expect(
      readMobileAttachmentMeta({
        ...block,
        _meta: { mobileAttachment: { id: '', kind: 'image', name: 'a', size: 1 } },
      }),
    ).toBeUndefined()
    expect(
      readMobileAttachmentMeta({
        ...block,
        _meta: { mobileAttachment: { id: 'a', kind: 'audio', name: 'a', size: 1 } },
      }),
    ).toBeUndefined()
    expect(
      readMobileAttachmentMeta({
        ...block,
        _meta: { mobileAttachment: { id: 'a', kind: 'file', name: 'a', size: -1 } },
      }),
    ).toBeUndefined()
  })

  it('drops stamps the phone protocol would reject', () => {
    const stamp = (overrides: Record<string, unknown>) => ({
      ...block,
      _meta: {
        mobileAttachment: { id: 'a', kind: 'file', name: 'a', size: 1, ...overrides },
      },
    })
    expect(
      readMobileAttachmentMeta(stamp({ id: 'x'.repeat(MAX_ATTACHMENT_ID_LENGTH + 1) })),
    ).toBeUndefined()
    expect(
      readMobileAttachmentMeta(stamp({ name: 'x'.repeat(MAX_ATTACHMENT_NAME_LENGTH + 1) })),
    ).toBeUndefined()
    expect(
      readMobileAttachmentMeta(stamp({ mimeType: 'x'.repeat(MAX_ATTACHMENT_MIME_LENGTH + 1) })),
    ).toBeUndefined()
    expect(readMobileAttachmentMeta(stamp({ size: MAX_FILE_ATTACHMENT_BYTES + 1 }))).toBeUndefined()
    expect(readMobileAttachmentMeta(stamp({ size: 1.5 }))).toBeUndefined()
  })
})
