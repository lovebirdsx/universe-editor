/*---------------------------------------------------------------------------------------------
 *  PC counterpart of the mobile PWA's message-image capture. Rasterizes the
 *  rendered body of one timeline message (never the collapsible header) so the
 *  action layer can hand the PNG to the host clipboard service. Kept separate
 *  from the action so the capture algorithm is testable without DI.
 *
 *  Deltas from apps/mobile/src/session/messageImage.ts:
 *   - the captured node is the message body, not a whole `.message` bubble, so
 *     the card-coloured frame comes from the nearest opaque ancestor;
 *   - styles are read through the element's own document (auxiliary windows are
 *     another realm);
 *   - the page-coloured margin uses the chat background, not `document.body`.
 *--------------------------------------------------------------------------------------------*/

type CaptureOptions = NonNullable<Parameters<typeof import('html-to-image').toBlob>[1]>

/** Conservative canvas limits shared with the mobile implementation. */
const MAX_CANVAS_SIDE = 4096
const MAX_CANVAS_AREA = 16_777_216
const PREFERRED_SCALE = 2
/** Page-coloured breathing room around a captured message, in CSS px. */
const CAPTURE_PADDING = 16
/** Valid 1x1 transparent PNG; failed image fetches (remote CORS/CSP) use it. */
const TRANSPARENT_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** Editor chrome that must not appear in the shared image. */
const EXCLUDED_SELECTORS = [
  '[data-testid="acp-user-message-actions"]',
  '[data-testid="acp-user-message-toggle"]',
  '[data-testid="code-block-copy"]',
  '[data-testid="acp-caret"]',
  '[data-testid="acp-collapsible-toggle"]',
].join(',')

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
 * Rasterizes one rendered message body (WYSIWYG) with a page-coloured margin
 * around it. A failed 2x attempt retries at 1x because large canvases can fail
 * after the fact.
 */
export async function renderMessageImage(element: HTMLElement): Promise<Blob> {
  const rect = element.getBoundingClientRect()
  if (!element.isConnected || rect.width <= 0 || rect.height <= 0) {
    throw new MessageImageUnavailableError()
  }
  const plan = planMessageCapture(
    rect.width + CAPTURE_PADDING * 2,
    rect.height + CAPTURE_PADDING * 2,
  )

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
  const computed = computedStyleOf(element)
  const background = computed.backgroundColor
  const border = `${CAPTURE_PADDING}px solid transparent`
  return {
    width: plan.width,
    height: plan.height,
    pixelRatio: plan.scale,
    type: 'image/png',
    // html-to-image fills the canvas with this colour before drawing the clone,
    // so the transparent border below lets it show as the outer margin.
    backgroundColor: chatBackgroundColor(element),
    // The editor renders with system fonts; embedding stylesheets would fetch
    // CSS the renderer CSP does not need to expose.
    skipFonts: true,
    imagePlaceholder: TRANSPARENT_PIXEL,
    // html-to-image hands text nodes to this filter too, hence the nodeType guard.
    filter: isCapturableNode,
    style: {
      // A user bubble's own max-width would resolve again against the
      // foreignObject width and reflow the captured content.
      maxWidth: 'none',
      boxSizing: 'border-box',
      border,
      // Logical and physical shorthands must agree: computed styles copied by
      // html-to-image contain both, and their serialized order decides which
      // one wins when the SVG style attribute is parsed back.
      borderBlock: border,
      borderInline: border,
      backgroundClip: 'padding-box',
      // The body itself is transparent; paint it with the nearest opaque card
      // colour so the shared image keeps the user/agent bubble background.
      backgroundColor: isTransparentColor(background) ? cardBackgroundColor(element) : background,
      ...paddedBorderRadii(computed),
    },
  }
}

function paddedBorderRadii(style: CSSStyleDeclaration): Partial<CSSStyleDeclaration> {
  const pad = (radius: string): string => `${cssPx(radius) + CAPTURE_PADDING}px`
  return {
    borderTopLeftRadius: pad(style.borderTopLeftRadius),
    borderTopRightRadius: pad(style.borderTopRightRadius),
    borderBottomRightRadius: pad(style.borderBottomRightRadius),
    borderBottomLeftRadius: pad(style.borderBottomLeftRadius),
    borderStartStartRadius: pad(style.borderStartStartRadius),
    borderStartEndRadius: pad(style.borderStartEndRadius),
    borderEndEndRadius: pad(style.borderEndEndRadius),
    borderEndStartRadius: pad(style.borderEndStartRadius),
  }
}

function cssPx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function computedStyleOf(element: HTMLElement): CSSStyleDeclaration {
  const view = element.ownerDocument.defaultView
  return view ? view.getComputedStyle(element) : getComputedStyle(element)
}

/** The chat area's background — the colour shown inside the capture margin. */
function chatBackgroundColor(element: HTMLElement): string {
  const chat = element.closest<HTMLElement>('[data-testid="acp-chat"]')
  if (chat !== null) {
    const background = computedStyleOf(chat).backgroundColor
    if (!isTransparentColor(background)) return background
  }
  return pageBackgroundColor(element.ownerDocument)
}

function pageBackgroundColor(doc: Document): string {
  if (doc.body !== null) {
    const background = computedStyleOf(doc.body).backgroundColor
    if (!isTransparentColor(background)) return background
  }
  return '#ffffff'
}

/** Nearest opaque ancestor background — the card's own colour behind the body. */
function cardBackgroundColor(element: HTMLElement): string {
  let current: HTMLElement | null = element
  while (current !== null) {
    const background = computedStyleOf(current).backgroundColor
    if (!isTransparentColor(background)) return background
    current = current.parentElement
  }
  return chatBackgroundColor(element)
}

function isTransparentColor(value: string): boolean {
  return (
    value === '' || value === 'transparent' || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(value)
  )
}

function isCapturableNode(node: HTMLElement): boolean {
  if (node.nodeType !== 1) return true
  return !(node as Element).matches(EXCLUDED_SELECTORS)
}

async function captureBlob(
  toBlob: typeof import('html-to-image').toBlob,
  element: HTMLElement,
  options: CaptureOptions,
): Promise<Blob> {
  const blob = await toBlob(element, options)
  if (blob === null || blob.size === 0) throw new MessageImageUnavailableError()
  return blob
}
