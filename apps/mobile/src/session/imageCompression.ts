/*---------------------------------------------------------------------------------------------
 *  Phone-side prompt image compression — mirrors the desktop implementation so the
 *  bytes uploaded to the PC gateway are already downscaled. WebP keeps
 *  transparency; GIFs pass through untouched to preserve animation.
 *--------------------------------------------------------------------------------------------*/

import {
  IMAGE_COMPRESS_FALLBACK_DIMENSION,
  IMAGE_COMPRESS_FALLBACK_QUALITY,
  IMAGE_COMPRESS_MAX_DIMENSION,
  IMAGE_COMPRESS_QUALITY,
  IMAGE_COMPRESS_TARGET_BYTES,
} from '@universe-editor/mobile-protocol'

export interface ImageCompressionDeps {
  readonly createImageBitmap?: (blob: Blob) => Promise<ImageBitmap>
  readonly createCanvas?: (width: number, height: number) => HTMLCanvasElement
}

/**
 * Downscale a prompt image when it is larger than the model samples at. Returns
 * the original blob unchanged for small images, GIFs, and undecodable input.
 */
export async function downscaleImage(blob: Blob, deps: ImageCompressionDeps = {}): Promise<Blob> {
  if (blob.type === 'image/gif') return blob
  const createBitmap = deps.createImageBitmap ?? globalThis.createImageBitmap
  if (typeof createBitmap !== 'function') return blob
  let bitmap: ImageBitmap
  try {
    bitmap = await createBitmap(blob)
  } catch {
    return blob
  }
  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height)
    if (longestEdge <= IMAGE_COMPRESS_MAX_DIMENSION && blob.size <= IMAGE_COMPRESS_TARGET_BYTES) {
      return blob
    }
    const primary = await encode(bitmap, IMAGE_COMPRESS_MAX_DIMENSION, IMAGE_COMPRESS_QUALITY, deps)
    if (primary.size <= IMAGE_COMPRESS_TARGET_BYTES) return primary
    const fallback = await encode(
      bitmap,
      IMAGE_COMPRESS_FALLBACK_DIMENSION,
      IMAGE_COMPRESS_FALLBACK_QUALITY,
      deps,
    )
    return fallback.size < primary.size ? fallback : primary
  } finally {
    bitmap.close()
  }
}

async function encode(
  bitmap: ImageBitmap,
  maxDimension: number,
  quality: number,
  deps: ImageCompressionDeps,
): Promise<Blob> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = deps.createCanvas?.(width, height) ?? document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('2d context unavailable')
  context.drawImage(bitmap, 0, 0, width, height)
  const webp = await toBlob(canvas, 'image/webp', quality)
  // Browsers that cannot encode WebP silently fall back to PNG; try JPEG
  // instead so the downscale still pays off.
  return webp.type === 'image/webp' ? webp : toBlob(canvas, 'image/jpeg', quality)
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error('image encoding failed')) : resolve(blob)),
      type,
      quality,
    )
  })
}
