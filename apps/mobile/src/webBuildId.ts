import { webBuildIdFromAssetUrl } from '@universe-editor/mobile-protocol'

export interface WebBuildMismatch {
  readonly serverBuildId: string
  readonly clientBuildId: string
}

/**
 * Entry script the page actually loaded. If the shell came from a cache, this
 * is the old build id even though the PC already serves a newer one.
 */
export function readClientWebBuildId(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): string | undefined {
  const script = doc?.querySelector<HTMLScriptElement>('script[type="module"][src]')
  return webBuildIdFromAssetUrl(script?.src)
}

export function compareWebBuildId(
  serverBuildId: string | undefined,
  clientBuildId: string | undefined,
): WebBuildMismatch | undefined {
  if (serverBuildId === undefined || clientBuildId === undefined) return undefined
  if (serverBuildId === clientBuildId) return undefined
  return { serverBuildId, clientBuildId }
}
