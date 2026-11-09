import { describe, expect, it } from 'vitest'
import { sanitizeAttachmentFileName } from '../attachmentNames.js'

describe('sanitizeAttachmentFileName', () => {
  it('keeps ordinary unicode names', () => {
    expect(sanitizeAttachmentFileName('季度报告 2026.pdf')).toBe('季度报告 2026.pdf')
  })

  it('strips path segments and Windows-illegal characters', () => {
    expect(sanitizeAttachmentFileName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sanitizeAttachmentFileName('C:\\temp\\a<b>c:d"e|f?g*h.txt')).toBe(
      'C__temp_a_b_c_d_e_f_g_h.txt',
    )
  })

  it('handles empty, dot and dot-dot names', () => {
    expect(sanitizeAttachmentFileName('')).toBe('attachment')
    expect(sanitizeAttachmentFileName('.')).toBe('attachment')
    expect(sanitizeAttachmentFileName('..')).toBe('attachment')
    expect(sanitizeAttachmentFileName(' . . ')).toBe('attachment')
  })

  it('escapes Windows reserved device names', () => {
    expect(sanitizeAttachmentFileName('CON')).toBe('_CON')
    expect(sanitizeAttachmentFileName('com1.txt')).toBe('_com1.txt')
    expect(sanitizeAttachmentFileName('LPT9')).toBe('_LPT9')
    expect(sanitizeAttachmentFileName('console.txt')).toBe('console.txt')
  })

  it('trims trailing dots and spaces', () => {
    expect(sanitizeAttachmentFileName('report.txt. . ')).toBe('report.txt')
  })

  it('truncates to 255 utf-8 bytes while keeping the extension', () => {
    const name = `${'图'.repeat(200)}.png`
    const sanitized = sanitizeAttachmentFileName(name)
    expect(Buffer.byteLength(sanitized, 'utf8')).toBeLessThanOrEqual(255)
    expect(sanitized.endsWith('.png')).toBe(true)
    expect(sanitized).not.toContain('\uFFFD')
  })

  it('does not end in a dot when an oversized extension is cut at the boundary', () => {
    const name = `${'a'.repeat(254)}.${'b'.repeat(300)}`
    const sanitized = sanitizeAttachmentFileName(name)
    expect(Buffer.byteLength(sanitized, 'utf8')).toBeLessThanOrEqual(255)
    expect(sanitized.endsWith('.')).toBe(false)
    expect(sanitized.endsWith(' ')).toBe(false)
  })
})
