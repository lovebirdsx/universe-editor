/**
 * ESLint interaction, isolated from the LSP transport so it can be unit-tested
 * with a fake ESLint. Resolves the *workspace's own* eslint (never a bundled
 * copy) from the linted file's directory — matching vscode-eslint — then maps
 * ESLint's offset-based results onto LSP diagnostics / text edits.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { URI } from 'vscode-uri'
import type { Diagnostic, TextEdit } from 'vscode-languageserver-types'
import { LineIndex } from './textUtils.js'
import { CodeActionKinds, type EslintCodeAction } from './protocol.js'

// --- minimal shape of the ESLint API we touch (eslint ships its own types, but
//     it's resolved at runtime, so we can't import them at compile time) -------

interface EslintFix {
  readonly range: readonly [number, number]
  readonly text: string
}

interface EslintSuggestion {
  readonly desc: string
  readonly fix: EslintFix
}

interface LintMessage {
  readonly ruleId: string | null
  readonly severity: 1 | 2
  readonly message: string
  readonly line: number
  readonly column: number
  readonly endLine?: number
  readonly endColumn?: number
  readonly fix?: EslintFix
  readonly suggestions?: readonly EslintSuggestion[]
}

interface LintResult {
  readonly filePath: string
  readonly messages: readonly LintMessage[]
  readonly output?: string
}

interface RuleMeta {
  readonly docs?: { readonly url?: string }
}

export interface EslintApi {
  lintText(code: string, options: { filePath: string }): Promise<LintResult[]>
  getRulesMetaForResults?(results: LintResult[]): Record<string, RuleMeta>
}

/** Constructs an ESLint instance; `fix` toggles autofix output. */
export type EslintConstructor = new (options: Record<string, unknown>) => EslintApi

/**
 * Resolve the workspace's `eslint` package from `fromDir` (the linted file's
 * directory). Returns undefined when the workspace has no eslint installed — the
 * server then stays quiet for that file instead of throwing, mirroring
 * vscode-eslint's "no ESLint library" degradation.
 */
export async function resolveEslintConstructor(
  fromDir: string,
): Promise<EslintConstructor | undefined> {
  try {
    const require = createRequire(pathToFileURL(`${fromDir}/__resolve__.js`))
    const entry = require.resolve('eslint')
    const mod = (await import(pathToFileURL(entry).href)) as {
      ESLint?: EslintConstructor
      default?: { ESLint?: EslintConstructor }
    }
    return mod.ESLint ?? mod.default?.ESLint
  } catch {
    return undefined
  }
}

/** Directory of a `file:` uri (POSIX slashes), for eslint resolution + filePath. */
export function fileDirOf(uri: string): string | undefined {
  const parsed = URI.parse(uri)
  if (parsed.scheme !== 'file') return undefined
  const fsPath = parsed.fsPath
  const slash = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'))
  return slash === -1 ? fsPath : fsPath.slice(0, slash)
}

export function filePathOf(uri: string): string | undefined {
  const parsed = URI.parse(uri)
  return parsed.scheme === 'file' ? parsed.fsPath : undefined
}

/** ESLint severity (1=warn, 2=error) → LSP DiagnosticSeverity (2=warn, 1=error). */
function toLspSeverity(sev: 1 | 2): 1 | 2 {
  return sev === 2 ? 1 : 2
}

/**
 * Lint `text` and return LSP diagnostics. Each fixable / documented message
 * carries the metadata later needed to build code actions, so we return the raw
 * messages alongside for the code-action path (avoids a second lint pass).
 */
export async function lintDocument(
  eslint: EslintApi,
  text: string,
  filePath: string,
): Promise<{ diagnostics: Diagnostic[]; messages: readonly LintMessage[] }> {
  const results = await eslint.lintText(text, { filePath })
  const result = results[0]
  if (!result) return { diagnostics: [], messages: [] }

  const ruleMeta = eslint.getRulesMetaForResults?.(results) ?? {}
  const diagnostics = result.messages.map((m) => toDiagnostic(m, ruleMeta))
  return { diagnostics, messages: result.messages }
}

/** One ESLint message → one LSP diagnostic, with a clickable rule-docs link. */
function toDiagnostic(m: LintMessage, ruleMeta: Record<string, RuleMeta>): Diagnostic {
  // ESLint is 1-based line + 1-based column; LSP is 0-based both. endLine/endColumn
  // are optional — fall back to a zero-width range at the start when absent.
  const start = { line: Math.max(0, m.line - 1), character: Math.max(0, m.column - 1) }
  const end =
    m.endLine !== undefined && m.endColumn !== undefined
      ? { line: Math.max(0, m.endLine - 1), character: Math.max(0, m.endColumn - 1) }
      : start
  const url = m.ruleId ? ruleMeta[m.ruleId]?.docs?.url : undefined
  const diagnostic: Diagnostic = {
    range: { start, end },
    message: m.message,
    severity: toLspSeverity(m.severity),
    source: 'eslint',
  }
  if (m.ruleId) diagnostic.code = m.ruleId
  if (url) diagnostic.codeDescription = { href: url }
  return diagnostic
}

/** A single ESLint fix ({range:[start,end], text}) → an LSP TextEdit. */
function fixToEdit(fix: EslintFix, index: LineIndex): TextEdit {
  return { range: index.rangeAt(fix.range[0], fix.range[1]), newText: fix.text }
}

/**
 * Build code actions for the messages overlapping `range`: one quick fix per
 * fixable message, one per suggestion, and disable-line / disable-file comment
 * inserts. The fix-all-for-file and format flows go through {@link computeFixAll}.
 */
export function buildCodeActions(
  text: string,
  messages: readonly LintMessage[],
  range: { start: { line: number }; end: { line: number } },
): EslintCodeAction[] {
  const index = new LineIndex(text)
  const actions: EslintCodeAction[] = []
  const lines = text.split(/\r\n|\r|\n/)

  for (const m of messages) {
    const msgLine = Math.max(0, m.line - 1)
    if (msgLine < range.start.line || msgLine > range.end.line) continue

    if (m.fix) {
      actions.push({
        title: m.ruleId ? `Fix this ${m.ruleId} problem` : 'Fix this problem',
        kind: CodeActionKinds.quickFix,
        isPreferred: true,
        edits: [fixToEdit(m.fix, index)],
      })
    }
    for (const s of m.suggestions ?? []) {
      actions.push({
        title: s.desc,
        kind: CodeActionKinds.quickFix,
        edits: [fixToEdit(s.fix, index)],
      })
    }
    if (m.ruleId) {
      actions.push(disableLineAction(m, lines))
    }
  }
  return actions
}

/** Insert an `// eslint-disable-next-line <rule>` comment above the message line,
 *  matching the target line's indentation. Line-comment syntax only (JS/TS). */
function disableLineAction(m: LintMessage, lines: readonly string[]): EslintCodeAction {
  const lineNo = Math.max(0, m.line - 1)
  const lineText = lines[lineNo] ?? ''
  const indent = lineText.slice(0, lineText.length - lineText.trimStart().length)
  const insertPos = { line: lineNo, character: 0 }
  return {
    title: `Disable ${m.ruleId} for this line`,
    kind: CodeActionKinds.quickFix,
    edits: [
      {
        range: { start: insertPos, end: insertPos },
        newText: `${indent}// eslint-disable-next-line ${m.ruleId}\n`,
      },
    ],
  }
}

/**
 * Run ESLint with autofix and return the whole-document replacement edit (or an
 * empty list when nothing changed). Used by fix-all command, format-as-formatter
 * and fix-all-on-save. A single full-range edit keeps the mapping trivial and
 * correct; Monaco collapses it into one undo step.
 */
export async function computeFixAll(
  EslintCtor: EslintConstructor,
  baseOptions: Record<string, unknown>,
  text: string,
  filePath: string,
): Promise<TextEdit[]> {
  const eslint = new EslintCtor({ ...baseOptions, fix: true })
  const results = await eslint.lintText(text, { filePath })
  const output = results[0]?.output
  if (output === undefined || output === text) return []
  const index = new LineIndex(text)
  return [{ range: index.fullRange(), newText: output }]
}
