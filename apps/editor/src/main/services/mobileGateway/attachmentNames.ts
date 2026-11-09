/**
 * File-name sanitization for phone-uploaded attachments. The upload id — not
 * this name — identifies the stored file, so the goal is only to keep the name
 * safe on every supported filesystem and usable as a `resource_link` label.
 */

import { MAX_ATTACHMENT_NAME_LENGTH } from '@universe-editor/mobile-protocol'

const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

export function sanitizeAttachmentFileName(raw: string): string {
  let name = raw.normalize('NFC')
  name = name
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
  name = name.replace(/[. ]+$/g, '')
  if (name === '' || name === '.' || name === '..') return 'attachment'

  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  if (isWindowsReserved(stem)) name = `_${name}`

  if (Buffer.byteLength(name, 'utf8') > MAX_ATTACHMENT_NAME_LENGTH) {
    const extensionBytes = Buffer.byteLength(extension, 'utf8')
    if (extensionBytes < MAX_ATTACHMENT_NAME_LENGTH) {
      const maxStemBytes = MAX_ATTACHMENT_NAME_LENGTH - extensionBytes
      const safeStem = truncateUtf8(stem, Math.max(1, maxStemBytes)).replace(/[. ]+$/g, '')
      name = `${safeStem === '' ? 'file' : safeStem}${extension}`
    } else {
      name = truncateUtf8(name, MAX_ATTACHMENT_NAME_LENGTH).replace(/[. ]+$/g, '')
    }
  }

  if (name === '' || name === '.' || name === '..') return 'attachment'
  return name
}

function isWindowsReserved(stem: string): boolean {
  return WINDOWS_RESERVED.has(stem.toUpperCase())
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let result = ''
  let used = 0
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    result += char
    used += size
  }
  return result
}
