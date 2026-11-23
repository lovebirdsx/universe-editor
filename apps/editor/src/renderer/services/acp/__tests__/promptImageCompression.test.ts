import { describe, expect, it, vi } from 'vitest'
import {
  IMAGE_COMPRESS_FALLBACK_DIMENSION,
  IMAGE_COMPRESS_MAX_DIMENSION,
  IMAGE_COMPRESS_TARGET_BYTES,
} from '@universe-editor/mobile-protocol'
import { downscaleImage, type ImageCompressionDeps } from '../promptImageCompression.js'

interface FakeBitmap {
  readonly width: number
  readonly height: number
  readonly close: ReturnType<typeof vi.fn>
}

function makeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() }
}

function makeCanvas(output: Blob): {
  readonly canvas: HTMLCanvasElement
  readonly drawImage: ReturnType<typeof vi.fn>
} {
  const drawImage = vi.fn()
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: (callback: (blob: Blob | null) => void) => callback(output),
  } as unknown as HTMLCanvasElement
  return { canvas, drawImage }
}

function depsFor(
  bitmap: FakeBitmap,
  output: Blob,
): ImageCompressionDeps & {
  readonly drawImage: ReturnType<typeof vi.fn>
  readonly canvas: HTMLCanvasElement
} {
  const { canvas, drawImage } = makeCanvas(output)
  return {
    createImageBitmap: vi.fn(async () => bitmap as unknown as ImageBitmap),
    createCanvas: () => canvas,
    drawImage,
    canvas,
  }
}

describe('downscaleImage', () => {
  it('returns small images untouched', async () => {
    const bitmap = makeBitmap(800, 600)
    const original = new Blob([new Uint8Array(64 * 1024)], { type: 'image/png' })
    const deps = depsFor(bitmap, original)
    await expect(downscaleImage(original, deps)).resolves.toBe(original)
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('downscales oversized images to the max dimension', async () => {
    const bitmap = makeBitmap(4000, 3000)
    const original = new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' })
    const compressed = new Blob([new Uint8Array(200 * 1024)], { type: 'image/webp' })
    const deps = depsFor(bitmap, compressed)
    await expect(downscaleImage(original, deps)).resolves.toBe(compressed)
    expect(deps.canvas.width).toBe(IMAGE_COMPRESS_MAX_DIMENSION)
    expect(deps.canvas.height).toBe(Math.round((3000 * IMAGE_COMPRESS_MAX_DIMENSION) / 4000))
    expect(deps.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      IMAGE_COMPRESS_MAX_DIMENSION,
      Math.round((3000 * IMAGE_COMPRESS_MAX_DIMENSION) / 4000),
    )
  })

  it('falls back to the smaller pass when the first encode is still too large', async () => {
    const bitmap = makeBitmap(4000, 3000)
    const original = new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' })
    const large = new Blob([new Uint8Array(IMAGE_COMPRESS_TARGET_BYTES + 1)], {
      type: 'image/webp',
    })
    const small = new Blob([new Uint8Array(300 * 1024)], { type: 'image/webp' })
    let calls = 0
    const { canvas } = makeCanvas(large)
    const deps: ImageCompressionDeps = {
      createImageBitmap: vi.fn(async () => bitmap as unknown as ImageBitmap),
      createCanvas: () => {
        calls += 1
        return canvas
      },
    }
    // First encode returns `large`, second returns `small`.
    const toBlob = vi
      .spyOn(canvas, 'toBlob')
      .mockImplementationOnce((callback) => callback(large))
      .mockImplementationOnce((callback) => callback(small))
    await expect(downscaleImage(original, deps)).resolves.toBe(small)
    expect(calls).toBe(2)
    expect(toBlob).toHaveBeenCalledTimes(2)
    expect(canvas.width).toBe(IMAGE_COMPRESS_FALLBACK_DIMENSION)
  })

  it('falls back to JPEG when the browser cannot encode WebP', async () => {
    const bitmap = makeBitmap(2000, 1000)
    const original = new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' })
    const png = new Blob([new Uint8Array(100 * 1024)], { type: 'image/png' })
    const jpeg = new Blob([new Uint8Array(90 * 1024)], { type: 'image/jpeg' })
    const { canvas } = makeCanvas(png)
    const deps: ImageCompressionDeps = {
      createImageBitmap: vi.fn(async () => bitmap as unknown as ImageBitmap),
      createCanvas: () => canvas,
    }
    vi.spyOn(canvas, 'toBlob')
      .mockImplementationOnce((callback) => callback(png))
      .mockImplementationOnce((callback) => callback(jpeg))
    await expect(downscaleImage(original, deps)).resolves.toBe(jpeg)
  })

  it('passes GIFs through untouched to preserve animation', async () => {
    const createImageBitmap = vi.fn()
    const gif = new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/gif' })
    await expect(downscaleImage(gif, { createImageBitmap })).resolves.toBe(gif)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('returns the original blob when the image cannot be decoded', async () => {
    const original = new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' })
    const deps: ImageCompressionDeps = {
      createImageBitmap: vi.fn(async () => {
        throw new Error('decode failed')
      }),
    }
    await expect(downscaleImage(original, deps)).resolves.toBe(original)
  })
})
