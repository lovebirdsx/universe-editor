/**
 * Build identifier shared by the gateway and the phone: the entry script's
 * file name. The gateway reads it from the served `index.html`; the phone reads
 * the module script the page actually loaded, so a stale shell can notice that
 * the PC was rebuilt even when the protocol version is unchanged.
 */
export const MAX_WEB_BUILD_ID_LENGTH = 256

export function webBuildIdFromAssetUrl(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined
  try {
    const pathname = new URL(url, 'https://mobile.invalid/').pathname
    const name = pathname.slice(pathname.lastIndexOf('/') + 1)
    return name !== '' && name.length <= MAX_WEB_BUILD_ID_LENGTH ? name : undefined
  } catch {
    return undefined
  }
}
