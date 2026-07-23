/**
 * Status-bar content for the TS language-server lifecycle (pure, so it is
 * unit-testable without the extension API). Loading shows a transient spinner;
 * once ready the item stays visible (VSCode-style) and the tooltip reports
 * which server implementation is running plus its version.
 */
import type { LspServerState, TsServerSpec } from './lspClient.js'
import { localize } from './nls.js'

export interface StatusBarContent {
  text: string
  tooltip: string
  showProgress: boolean | 'spinning'
  visible: boolean
}

const SERVER_LABEL: Record<TsServerSpec['kind'], string> = {
  tsls: 'typescript-language-server (tsserver)',
  native: 'TypeScript Native (tsgo)',
}

export function statusBarContent(spec: TsServerSpec, state: LspServerState): StatusBarContent {
  const server = SERVER_LABEL[spec.kind]
  switch (state) {
    case 'starting':
      return {
        text: '',
        tooltip: localize(
          'ts.status.starting.tooltip',
          'Starting TypeScript language service… ({server})',
          { server },
        ),
        showProgress: 'spinning',
        visible: true,
      }
    case 'ready':
      // Icon-only (the accessible label falls back to the tooltip) so the entry
      // doesn't repeat the Editor Language indicator's "TypeScript" text.
      return {
        text: '$(pulse)',
        tooltip: `${server}\n${localize('ts.status.version', 'Version')}: ${spec.version}`,
        showProgress: false,
        visible: true,
      }
    case 'error':
      return {
        text: '$(error)',
        tooltip: localize(
          'ts.status.error.tooltip',
          'TypeScript language service failed to start ({server})',
          { server },
        ),
        showProgress: false,
        visible: true,
      }
  }
}
