/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  "Fix with AI" prompt assembly for the marker-hover AI code action.
 *  snapshotAiFixArg freezes the markers + surrounding code at provider time
 *  (so edits between hover and click can't drift the payload);
 *  composeAiFixPrompt turns that snapshot into the user message sent to the
 *  agent. Line/column info rides in the text body — agents drop structured
 *  _meta (same red line as promptRef). Pure + monaco-free for unit tests.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { SelectionContext } from './promptContext.js'

export interface AiFixProblem {
  readonly message: string
  readonly source?: string
  readonly code?: string
  readonly severity: number
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
}

export interface AiFixProblemArg {
  readonly resource: string
  readonly contexts: readonly SelectionContext[]
  readonly problems: readonly AiFixProblem[]
}

/** Minimal marker shape, structurally satisfied by monaco's `editor.IMarker`. */
export interface AiFixMarker {
  readonly message: string
  readonly source?: string
  readonly code?: string | { readonly value: string }
  readonly severity: number
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
}

/** Minimal model shape, structurally satisfied by monaco's `editor.ITextModel`. */
export interface AiFixModel {
  readonly uri: { toString(): string }
  getLineCount(): number
  getLineMaxColumn(lineNumber: number): number
  getValueInRange(range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }): string
  getLanguageId(): string
}

const CONTEXT_PADDING_LINES = 3
const MAX_SNIPPET_CHARS = 4000
const MAX_LISTED_PROBLEMS = 5

// monaco MarkerSeverity: Hint=1, Info=2, Warning=4, Error=8.
function severityText(severity: number): string {
  if (severity >= 8) return localize('acp.aiFix.severity.error', 'Error')
  if (severity >= 4) return localize('acp.aiFix.severity.warning', 'Warning')
  if (severity >= 2) return localize('acp.aiFix.severity.info', 'Info')
  return localize('acp.aiFix.severity.hint', 'Hint')
}

/** relPath comes from the caller (toMentionName) so this stays workspace-agnostic. */
export function snapshotAiFixArg(
  model: AiFixModel,
  markers: readonly AiFixMarker[],
  relPath: string,
): AiFixProblemArg {
  const lineCount = model.getLineCount()
  let startLine = lineCount
  let endLine = 1
  for (const m of markers) {
    startLine = Math.min(startLine, m.startLineNumber - CONTEXT_PADDING_LINES)
    endLine = Math.max(endLine, m.endLineNumber + CONTEXT_PADDING_LINES)
  }
  startLine = Math.max(1, startLine)
  endLine = Math.min(lineCount, endLine)

  let text = model.getValueInRange({
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: model.getLineMaxColumn(endLine),
  })
  if (text.length > MAX_SNIPPET_CHARS) {
    text = text.slice(0, MAX_SNIPPET_CHARS) + '\n…'
  }

  const languageId = model.getLanguageId()
  const context: SelectionContext = {
    uri: model.uri.toString(),
    relPath,
    text,
    startLine,
    endLine,
    ...(languageId ? { languageId } : {}),
  }

  return {
    resource: model.uri.toString(),
    contexts: [context],
    problems: markers.map((m) => ({
      message: m.message,
      ...(m.source ? { source: m.source } : {}),
      ...(m.code !== undefined ? { code: typeof m.code === 'string' ? m.code : m.code.value } : {}),
      severity: m.severity,
      startLineNumber: m.startLineNumber,
      startColumn: m.startColumn,
      endLineNumber: m.endLineNumber,
      endColumn: m.endColumn,
    })),
  }
}

export function composeAiFixPrompt(arg: AiFixProblemArg): {
  text: string
  contexts: readonly SelectionContext[]
} {
  const relPath = arg.contexts[0]?.relPath ?? arg.resource
  const lines = [
    localize(
      'acp.aiFix.prompt.header',
      'Fix the following problems in {path} (the relevant code is attached as context):',
      { path: relPath },
    ),
  ]
  for (const p of arg.problems.slice(0, MAX_LISTED_PROBLEMS)) {
    const location =
      p.startLineNumber === p.endLineNumber
        ? `${p.startLineNumber}:${p.startColumn}`
        : `${p.startLineNumber}:${p.startColumn}-${p.endLineNumber}:${p.endColumn}`
    const code = p.code !== undefined ? ` (${p.code})` : ''
    const source = p.source !== undefined ? ` [${p.source}]` : ''
    lines.push(`- ${severityText(p.severity)} at ${location}: ${p.message}${code}${source}`)
  }
  if (arg.problems.length > MAX_LISTED_PROBLEMS) {
    lines.push(
      localize('acp.aiFix.prompt.more', '…and {count} more', {
        count: arg.problems.length - MAX_LISTED_PROBLEMS,
      }),
    )
  }
  lines.push(
    '',
    localize('acp.aiFix.prompt.instruction', 'Apply a minimal fix directly to the file.'),
  )
  return { text: lines.join('\n'), contexts: arg.contexts }
}
