/**
 * Registers the markdown editing commands. Each command fetches the active
 * markdown editor, computes a pure result from the `edit/*` cores, and applies
 * it. Keybindings are contributed in package.json (gated on `editorTextFocus &&
 * editorLangId == markdown`); because the global key handler preventDefaults a
 * winning binding, the smart Enter/Tab commands reproduce the default keystroke
 * themselves when the cursor isn't in a list/table.
 */
import { commands, type ExtensionContext, type Position } from '@universe-editor/extension-api'
import {
  activeMarkdown,
  applyResult,
  cursor,
  range,
  type ActiveMarkdown,
  type EditResult,
  type Selection,
} from './textEditing.js'
import { toggleDelimiter } from './toggleDelimiter.js'
import { changeHeadingLevel } from './heading.js'
import { toggleTask } from './task.js'
import { computeSmartEnter, computeIndent, computeOutdent, INDENT_UNIT } from './smartList.js'
import { formatTable, navigateTable } from './table.js'

type ActiveMd = ActiveMarkdown

export const MARKDOWN_COMMANDS = {
  toggleBold: 'markdown.editing.toggleBold',
  toggleItalic: 'markdown.editing.toggleItalic',
  toggleCode: 'markdown.editing.toggleInlineCode',
  toggleStrikethrough: 'markdown.editing.toggleStrikethrough',
  toggleMath: 'markdown.editing.toggleMath',
  headingUp: 'markdown.editing.headingUp',
  headingDown: 'markdown.editing.headingDown',
  toggleTask: 'markdown.editing.toggleTask',
  onEnter: 'markdown.editing.onEnter',
  onTab: 'markdown.editing.onTab',
  onShiftTab: 'markdown.editing.onShiftTab',
  formatTable: 'markdown.editing.formatTable',
} as const

function register(context: ExtensionContext, id: string, handler: () => Promise<void>): void {
  context.subscriptions.push(commands.registerCommand(id, () => handler()))
}

async function applyToggle(delim: string): Promise<void> {
  const md = await activeMarkdown()
  if (!md) return
  const result = toggleDelimiter(md.lines, md.selections, delim)
  if (result) await applyResult(md.editor, result)
}

async function applyHeading(delta: number): Promise<void> {
  const md = await activeMarkdown()
  if (!md) return
  await applyResult(md.editor, changeHeadingLevel(md.lines, md.selections, delta))
}

/** Replace every selection with `text`, leaving the cursor after it. The
 *  fallback for smart Enter/Tab when no list/table handling applies. */
function literalInsert(md: ActiveMd, text: string): EditResult {
  const edits = md.selections.map((sel) => {
    const [start, end] = orderEnds(sel)
    return { range: range(start.line, start.character, end.line, end.character), text }
  })
  const sel = md.selections[0]!
  const [start] = orderEnds(sel)
  const caret =
    text === '\n' ? cursor(start.line + 1, 0) : cursor(start.line, start.character + text.length)
  return { edits, selections: [caret] }
}

function orderEnds(sel: Selection): [Position, Position] {
  const a = sel.anchor
  const b = sel.active
  if (a.line < b.line || (a.line === b.line && a.character <= b.character)) return [a, b]
  return [b, a]
}

export function registerEditingCommands(context: ExtensionContext): void {
  register(context, MARKDOWN_COMMANDS.toggleBold, () => applyToggle('**'))
  register(context, MARKDOWN_COMMANDS.toggleItalic, () => applyToggle('*'))
  register(context, MARKDOWN_COMMANDS.toggleCode, () => applyToggle('`'))
  register(context, MARKDOWN_COMMANDS.toggleStrikethrough, () => applyToggle('~~'))
  register(context, MARKDOWN_COMMANDS.toggleMath, () => applyToggle('$'))
  register(context, MARKDOWN_COMMANDS.headingUp, () => applyHeading(1))
  register(context, MARKDOWN_COMMANDS.headingDown, () => applyHeading(-1))

  register(context, MARKDOWN_COMMANDS.toggleTask, async () => {
    const md = await activeMarkdown()
    if (!md) return
    await applyResult(md.editor, toggleTask(md.lines, md.selections))
  })

  register(context, MARKDOWN_COMMANDS.onEnter, async () => {
    const md = await activeMarkdown()
    if (!md) return
    const smart = computeSmartEnter(md.lines, md.selections)
    await applyResult(md.editor, smart === 'default' ? literalInsert(md, '\n') : smart)
  })

  register(context, MARKDOWN_COMMANDS.onTab, async () => {
    const md = await activeMarkdown()
    if (!md) return
    const nav = navigateTable(md.lines, md.selections, 'next')
    if (nav) return applyResult(md.editor, nav)
    const indent = computeIndent(md.lines, md.selections)
    await applyResult(md.editor, indent === 'default' ? literalInsert(md, INDENT_UNIT) : indent)
  })

  register(context, MARKDOWN_COMMANDS.onShiftTab, async () => {
    const md = await activeMarkdown()
    if (!md) return
    const nav = navigateTable(md.lines, md.selections, 'prev')
    if (nav) return applyResult(md.editor, nav)
    const outdent = computeOutdent(md.lines, md.selections)
    if (outdent !== 'default') await applyResult(md.editor, outdent)
    // No list to outdent and not in a table: do nothing (Shift+Tab has no
    // meaningful literal insertion).
  })

  register(context, MARKDOWN_COMMANDS.formatTable, async () => {
    const md = await activeMarkdown()
    if (!md) return
    const sel = md.selections[0]
    if (!sel) return
    const result = formatTable(md.lines, sel.active.line)
    if (result) await applyResult(md.editor, result)
  })
}
