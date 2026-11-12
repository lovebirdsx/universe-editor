/** Clipboard access for the mobile PWA. Secure contexts expose the async API;
 *  the LAN self-signed tier is not a secure context, so text needs the legacy
 *  path and images can only be handed to the preview overlay. */
export async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = currentClipboard()
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Permission/focus failures fall through to the legacy path.
    }
  }
  return copyTextFallback(text)
}

/**
 * Writes a PNG to the clipboard. WebKit only preserves the user-gesture
 * clipboard grant inside the synchronous click stack, so the pending capture
 * Promise is handed to `ClipboardItem` instead of awaiting it first.
 */
export function writeClipboardImage(image: Blob | Promise<Blob>): Promise<boolean> {
  try {
    const clipboard = currentClipboard()
    const ClipboardItemCtor = globalThis.ClipboardItem
    if (typeof ClipboardItemCtor === 'undefined' || typeof clipboard?.write !== 'function') {
      return Promise.resolve(false)
    }
    if (
      typeof ClipboardItemCtor.supports === 'function' &&
      !ClipboardItemCtor.supports('image/png')
    ) {
      return Promise.resolve(false)
    }
    const written = clipboard.write([
      new ClipboardItemCtor({ 'image/png': Promise.resolve(image) }),
    ])
    return written.then(
      () => true,
      () => false,
    )
  } catch {
    return Promise.resolve(false)
  }
}

function currentClipboard(): Clipboard | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.clipboard
}

function copyTextFallback(text: string): boolean {
  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.opacity = '0'
  // 16px avoids iOS Safari zooming the page when the textarea receives focus.
  textarea.style.fontSize = '16px'
  document.body.appendChild(textarea)
  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return typeof document.execCommand === 'function' && document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
