import type { Terminal } from '@xterm/xterm'

type ClipboardTerminal = Pick<Terminal, 'getSelection' | 'hasSelection' | 'paste'>

interface TextClipboard {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

function getClipboard(clipboard?: TextClipboard): TextClipboard | undefined {
  return clipboard ?? globalThis.navigator?.clipboard
}

export async function copyTerminalSelection(
  term: Pick<ClipboardTerminal, 'getSelection' | 'hasSelection'>,
  clipboard?: TextClipboard,
): Promise<void> {
  if (!term.hasSelection()) return
  const text = term.getSelection()
  if (!text) return
  await getClipboard(clipboard)?.writeText(text)
}

export async function pasteClipboardIntoTerminal(
  term: Pick<ClipboardTerminal, 'paste'>,
  clipboard?: TextClipboard,
): Promise<void> {
  const text = await getClipboard(clipboard)?.readText()
  if (text) term.paste(text)
}

function isPlainCtrlKey(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
}

export function handleTerminalClipboardKey(
  event: KeyboardEvent,
  term: ClipboardTerminal,
  clipboard?: TextClipboard,
): boolean {
  if (event.type !== 'keydown' || !isPlainCtrlKey(event)) return true

  const key = event.key.toLowerCase()
  if (key === 'c') {
    if (!term.hasSelection()) return true
    event.preventDefault()
    event.stopPropagation()
    void copyTerminalSelection(term, clipboard).catch(() => {})
    return false
  }

  if (key === 'v') {
    event.preventDefault()
    event.stopPropagation()
    void pasteClipboardIntoTerminal(term, clipboard).catch(() => {})
    return false
  }

  return true
}
