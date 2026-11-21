/** The restricted surface the renderer injects into a trusted-view component. */
import type { ReactNode } from 'react'

export type TrustedViewLocation = 'view' | 'editor'

export interface TrustedViewContext {
  readonly extensionId: string
  readonly viewId: string
  readonly sessionId: string
  readonly location: TrustedViewLocation
  /** Editor: the state passed to `openTrustedEditor`; view: `undefined`. */
  readonly state: unknown
  /** Ask the extension's host-side provider (`handleRequest`). */
  request<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  /** Receive `TrustedViewSession.postEvent` from the provider. */
  onEvent(listener: (name: string, data: unknown) => void): { dispose(): void }
  /** Update the editor tab label. Ignored for `location === 'view'`. */
  setTitle(title: string): void
  /** Inject a `<style>` shared by the view; removed automatically on unmount. */
  addStyleSheet(css: string): { dispose(): void }
  readonly log: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
}

export interface TrustedViewComponentProps {
  readonly context: TrustedViewContext
}

/** Default export shape of a trusted-view browser ESM entry. */
export type TrustedViewComponent = (props: TrustedViewComponentProps) => ReactNode
