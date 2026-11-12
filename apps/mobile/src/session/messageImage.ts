type CaptureOptions = NonNullable<Parameters<typeof import('html-to-image').toBlob>[1]>

/** Canvas limits are conservative: older iOS Safari caps the area at 4096². */
const MAX_CANVAS_SIDE = 4096
const MAX_CANVAS_AREA = 16_777_216
const PREFERRED_SCALE = 2
/** Valid 1x1 transparent PNG; failed image fetches (remote CORS/CSP) use it. */
const TRANSPARENT_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

export class MessageImageTooLargeError extends Error {
  constructor() {
    super('message image is too large')
    this.name = 'MessageImageTooLargeError'
  }
}

export class MessageImageUnavailableError extends Error {
  constructor() {
    super('message image capture is unavailable')
    this.name = 'MessageImageUnavailableError'
  }
}

export interface MessageCapturePlan {
  readonly width: number
  readonly height: number
  readonly scale: 1 | 2
}

export function planMessageCapture(width: number, height: number): MessageCapturePlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new MessageImageTooLargeError()
  }
  const cssWidth = Math.ceil(width)
  const cssHeight = Math.ceil(height)
  for (const scale of [PREFERRED_SCALE, 1] as const) {
    const pixelWidth = cssWidth * scale
    const pixelHeight = cssHeight * scale
    if (
      pixelWidth <= MAX_CANVAS_SIDE &&
      pixelHeight <= MAX_CANVAS_SIDE &&
      pixelWidth * pixelHeight <= MAX_CANVAS_AREA
    ) {
      return { width: cssWidth, height: cssHeight, scale }
    }
  }
  throw new MessageImageTooLargeError()
}

/**
 * Rasterizes one rendered message. The live node is captured (WYSIWYG) with the
 * action button filtered out; a failed 2x attempt retries at 1x because canvas
 * size limits fail late on mobile Safari.
 */
export async function renderMessageImage(element: HTMLElement): Promise<Blob> {
  const rect = element.getBoundingClientRect()
  if (!element.isConnected || rect.width <= 0 || rect.height <= 0) {
    throw new MessageImageUnavailableError()
  }
  const action = element.querySelector<HTMLElement>('.message__actions')
  const actionHeight = action === null ? 0 : action.getBoundingClientRect().height
  const plan = planMessageCapture(rect.width, rect.height - actionHeight)

  let capture: typeof import('html-to-image')
  try {
    capture = await import('html-to-image')
  } catch {
    throw new MessageImageUnavailableError()
  }

  const options = buildOptions(element, plan)
  try {
    return await captureBlob(capture.toBlob, element, options)
  } catch (error) {
    if (plan.scale === 1) throw error
    return captureBlob(capture.toBlob, element, { ...options, pixelRatio: 1 })
  }
}

function buildOptions(element: HTMLElement, plan: MessageCapturePlan): CaptureOptions {
  const background = captureBackground(element)
  const options: CaptureOptions = {
    width: plan.width,
    height: plan.height,
    pixelRatio: plan.scale,
    type: 'image/png',
    // Mobile renders with system fonts only; embedding web fonts would fetch
    // stylesheets the gateway CSP does not need to expose.
    skipFonts: true,
    imagePlaceholder: TRANSPARENT_PIXEL,
    // The filter receives text nodes too, hence the Element guard.
    filter: (node: HTMLElement) =>
      !(node instanceof Element && node.classList.contains('message__actions')),
    // A user bubble's max-width: 86% resolves again against the foreignObject
    // width and would narrow/reflow the captured bubble.
    style: { maxWidth: 'none' },
  }
  if (background !== undefined) options.backgroundColor = background
  return options
}

function captureBackground(element: HTMLElement): string | undefined {
  // html-to-image writes backgroundColor onto the cloned root; skipping it for
  // an opaque bubble keeps its accent background and white text intact.
  if (!isTransparentColor(getComputedStyle(element).backgroundColor)) return undefined
  if (typeof document === 'undefined') return undefined
  const body = getComputedStyle(document.body).backgroundColor
  return isTransparentColor(body) ? '#ffffff' : body
}

function isTransparentColor(value: string): boolean {
  return (
    value === '' || value === 'transparent' || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(value)
  )
}

async function captureBlob(
  toBlob: typeof import('html-to-image').toBlob,
  element: HTMLElement,
  options: CaptureOptions,
): Promise<Blob> {
  const blob = await toBlob(element, options)
  if (blob === null || blob.size === 0) throw new Error('message image capture returned no data')
  return blob
}
