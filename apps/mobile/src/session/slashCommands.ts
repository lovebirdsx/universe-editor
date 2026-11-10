import type { MobileAvailableCommand } from '@universe-editor/mobile-protocol'

export interface SlashQuery {
  /** Text after the leading `/`, up to the first whitespace. */
  readonly query: string
  /** Offset of the first whitespace after the command token. */
  readonly tokenEnd: number
}

/** Wire names never carry a leading slash; the phone adds it for display. */
export function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, '')
}

export function formatCommandName(name: string): string {
  return `/${normalizeCommandName(name)}`
}

/**
 * Mirrors the desktop `PromptInput.extractSlashQuery`: only the first token of
 * a prompt that starts with `/` is a command, and the caret must stay inside
 * that token. Once the caret moves past the whitespace the list closes.
 */
export function extractSlashQuery(text: string, caret: number): SlashQuery | null {
  if (!text.startsWith('/')) return null
  let end = 1
  while (end < text.length && !/\s/.test(text[end]!)) end++
  if (caret > end) return null
  return { query: text.slice(1, end), tokenEnd: end }
}

export function filterSlashCommands(
  commands: readonly MobileAvailableCommand[],
  query: string,
): readonly MobileAvailableCommand[] {
  const needle = normalizeCommandName(query).toLowerCase()
  if (needle.length === 0) return commands
  return commands
    .map((command, index) => {
      const name = normalizeCommandName(command.name).toLowerCase()
      const description = command.description.toLowerCase()
      const score =
        name === needle
          ? 300
          : name.startsWith(needle)
            ? 200
            : name.includes(needle)
              ? 100
              : description.includes(needle)
                ? 0
                : -1
      return { command, index, score }
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command)
}

/**
 * Replaces the leading command token and leaves the caret where the user
 * starts typing arguments. Keeping the caret past the whitespace also makes
 * `extractSlashQuery` return null, so the suggestion list closes itself.
 */
export function applySlashCommand(
  text: string,
  tokenEnd: number,
  commandName: string,
): { readonly text: string; readonly caret: number } {
  const inserted = formatCommandName(commandName)
  const rest = text.slice(Math.min(Math.max(tokenEnd, 1), text.length))
  if (rest.length === 0) {
    return { text: inserted + ' ', caret: inserted.length + 1 }
  }
  const leadingWhitespace = /^\s*/.exec(rest)?.[0].length ?? 0
  if (leadingWhitespace > 0) {
    return { text: inserted + rest, caret: inserted.length + leadingWhitespace }
  }
  return { text: inserted + ' ' + rest, caret: inserted.length + 1 }
}
