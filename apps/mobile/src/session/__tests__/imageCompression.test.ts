import { describe, expect, it, vi } from 'vitest'
import { downscaleImage, type ImageCompressionDeps } from '../imageCompression.js'

function bitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap
}

function canvasFor(output: Blob): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (callback: (blob: Blob | null) => void) => callback(output),
  } as unknown as HTMLCanvasElement
}

function deps(image: ImageBitmap, output: Blob): ImageCompressionDeps {
  return {
    createImageBitmap: vi.fn(async () => image),
    createCanvas: () => canvasFor(output),
  }
}

describe('downscaleImage (phone)', () => {
  it('returns small images untouched', async () => {
    const original = new Blob([new Uint8Array(64 * 1024)], { type: 'image/jpeg' })
    await expect(downscaleImage(original, deps(bitmap(640, 480), original))).resolves.toBe(original)
  })

  it('downscales oversized images', async () => {
    const original = new Blob([new Uint8Array(4 * 1024 * 1024)], { type: 'image/png' })
    const compressed = new Blob([new Uint8Array(256 * 1024)], { type: 'image/webp' })
    await expect(downscaleImage(original, deps(bitmap(4032, 3024), compressed))).resolves.toBe(
      compressed,
    )
  })

  it('passes GIFs through to preserve animation', async () => {
    const createImageBitmap = vi.fn()
    const gif = new Blob([new Uint8Array(4 * 1024 * 1024)], { type: 'image/gif' })
    await expect(downscaleImage(gif, { createImageBitmap })).resolves.toBe(gif)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })
})
