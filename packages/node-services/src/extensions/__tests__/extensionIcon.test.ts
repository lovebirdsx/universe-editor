/*---------------------------------------------------------------------------------------------
 *  Tests for packages/node-services/src/extensions/extensionIcon.ts
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readExtensionIconDataUrl } from '../extensionIcon.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ext-icon-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readExtensionIconDataUrl', () => {
  it('reads a png icon as a data URL with the right MIME', async () => {
    await mkdir(path.join(root, 'media'), { recursive: true })
    await writeFile(path.join(root, 'media', 'icon.png'), Buffer.from('png-bytes'))

    expect(await readExtensionIconDataUrl(root, 'media/icon.png')).toBe(
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
    )
  })

  it('maps svg/jpg/gif/webp extensions to their MIME types', async () => {
    await writeFile(path.join(root, 'a.svg'), 'x')
    await writeFile(path.join(root, 'b.jpg'), 'x')
    await writeFile(path.join(root, 'c.jpeg'), 'x')
    await writeFile(path.join(root, 'd.gif'), 'x')
    await writeFile(path.join(root, 'e.webp'), 'x')

    expect(await readExtensionIconDataUrl(root, 'a.svg')).toContain('image/svg+xml')
    expect(await readExtensionIconDataUrl(root, 'b.jpg')).toContain('image/jpeg')
    expect(await readExtensionIconDataUrl(root, 'c.jpeg')).toContain('image/jpeg')
    expect(await readExtensionIconDataUrl(root, 'd.gif')).toContain('image/gif')
    expect(await readExtensionIconDataUrl(root, 'e.webp')).toContain('image/webp')
  })

  it('returns empty for a path escaping the extension folder, even when the target exists', async () => {
    const extDir = path.join(root, 'ext')
    await mkdir(extDir, { recursive: true })
    await writeFile(path.join(root, 'outside.png'), 'secret')
    expect(await readExtensionIconDataUrl(extDir, '../outside.png')).toBe('')
  })

  it('returns empty when the icon is absent', async () => {
    expect(await readExtensionIconDataUrl(root, 'missing.png')).toBe('')
  })
})
