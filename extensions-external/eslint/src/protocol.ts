/**
 * Wire protocol shared between the ESLint client (extension host) and the
 * standalone ESLint language server. Standard LSP where it fits (initialize,
 * document sync, publishDiagnostics), plus a few custom requests for the
 * fix/format flows that don't map cleanly onto stock LSP messages.
 *
 * All positions are LSP-shaped: 0-based line + 0-based character.
 */
import type { Diagnostic, TextEdit } from 'vscode-languageserver-types'

/** User-facing ESLint settings the client forwards to the server. */
export interface EslintSettings {
  readonly validate: readonly string[]
  readonly run: 'onType' | 'onSave'
  /** Extra options passed straight to the ESLint constructor (overrideConfigFile, …). */
  readonly options: Record<string, unknown>
}

export interface InitializeParams {
  readonly processId: number
  readonly rootUri: string | null
  readonly settings: EslintSettings
}

export interface DidOpenParams {
  readonly uri: string
  readonly languageId: string
  readonly version: number
  readonly text: string
}

export interface DidChangeParams {
  readonly uri: string
  readonly version: number
  readonly text: string
}

export interface DidCloseParams {
  readonly uri: string
}

export interface DidSaveParams {
  readonly uri: string
}

export interface PublishDiagnosticsParams {
  readonly uri: string
  readonly diagnostics: readonly Diagnostic[]
}

/** Request: code actions for a range (quick fixes + fix-all + disable comments). */
export interface CodeActionParams {
  readonly uri: string
  readonly range: {
    readonly start: { line: number; character: number }
    readonly end: { line: number; character: number }
  }
}

/** A code action returned by the server — always edit-based (no command routing),
 *  so the client converts it straight to a Monaco code action. */
export interface EslintCodeAction {
  readonly title: string
  readonly kind: string
  readonly isPreferred?: boolean
  readonly edits: readonly TextEdit[]
}

/** Request: compute the fix-all edits for a whole document (format / save / command). */
export interface FixAllParams {
  readonly uri: string
}

export interface FixAllResult {
  readonly edits: readonly TextEdit[]
}

export interface UpdateSettingsParams {
  readonly settings: EslintSettings
}

/** Log severity mirrored to the ESLint output channel (client renders a prefix). */
export type EslintLogLevel = 'info' | 'warn' | 'error'

/** Notification: server → client. A line for the ESLint output channel. */
export interface LogMessageParams {
  readonly level: EslintLogLevel
  readonly message: string
}

/** Runtime health of the ESLint integration, surfaced in the status bar. */
export type EslintStatus = 'ok' | 'warn' | 'error'

/** Notification: server → client. Coarse health so the UI can show a state
 *  indicator (e.g. "no ESLint resolvable" vs. "linting"). `message` is an
 *  optional human-readable detail for the tooltip. `busy` drives a progress
 *  spinner while a lint pass runs — type-aware configs can take 10s+ on the
 *  first pass, and without it the UI looks idle/broken. */
export interface StatusParams {
  readonly status: EslintStatus
  readonly message?: string
  readonly busy?: boolean
}

/** Method names (kept as constants so client and server can't drift). */
export const EslintMethods = {
  initialize: 'initialize',
  updateSettings: 'eslint/updateSettings',
  didOpen: 'textDocument/didOpen',
  didChange: 'textDocument/didChange',
  didSave: 'textDocument/didSave',
  didClose: 'textDocument/didClose',
  publishDiagnostics: 'textDocument/publishDiagnostics',
  codeAction: 'textDocument/codeAction',
  fixAllEdits: 'eslint/fixAllEdits',
  logMessage: 'eslint/logMessage',
  status: 'eslint/status',
} as const

/** Code-action kinds (mirror LSP / Monaco standard kinds). */
export const CodeActionKinds = {
  quickFix: 'quickfix',
  sourceFixAll: 'source.fixAll.eslint',
} as const
