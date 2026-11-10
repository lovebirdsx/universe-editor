/**
 * Numbered Bookmarks: Delphi-style 0-9 bookmarks, globally unique across the
 * whole workspace. Toggle a numbered bookmark on the current line, jump straight
 * back to it (even across files), list every bookmark with a line preview, and
 * see it as a digit in the glyph margin. Bookmarks are sticky (they ride line
 * edits above them) and persist via the host storage service (workspaceState) —
 * never a json file in the workspace.
 *
 * Runs in the extension host: `activate` wires commands, mirrors the active
 * editor to keep decorations painted, and watches document edits for stickiness.
 */

import {
  commands,
  window,
  workspace,
  type ExtensionContext,
  type QuickPickItem,
  type Range,
  type TextEditor,
} from '@universe-editor/extension-api'
import { BookmarkStore, SLOT_COUNT, type Bookmark } from './bookmarks.js'
import { DecorationProvider, type DecorationColors } from './decorations.js'
import { keyToFsPath, uriToKey } from './paths.js'
import { applyDocumentChange } from './sticky.js'
import { load, save } from './persistence.js'

function lineRange(line: number): Range {
  return { start: { line, character: 0 }, end: { line, character: 0 } }
}

function basename(path: string): string {
  const i = path.replace(/\\/g, '/').lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

async function readColors(): Promise<DecorationColors> {
  const cfg = workspace.getConfiguration('numberedBookmarks')
  const fill = await cfg.get('gutterIconFillColor', '#0070e0')
  const number = await cfg.get('gutterIconNumberColor', '#ffffff')
  return { fill, number }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const store = new BookmarkStore()
  const decorations = new DecorationProvider()
  context.subscriptions.push({ dispose: () => decorations.dispose() })

  decorations.ensure(await readColors())
  load(context.workspaceState, store)

  // Snapshots of open documents' text, keyed by document, to diff edits against
  // for sticky bookmarks (the change event carries only the new full text).
  const lastText = new Map<string, string>()
  for (const doc of workspace.textDocuments) {
    lastText.set(uriToKey(doc.uri), doc.getText())
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void save(context.workspaceState, store)
    }, 250)
  }
  context.subscriptions.push({
    dispose: () => {
      if (saveTimer) clearTimeout(saveTimer)
    },
  })

  /** Repaint every slot for `editor`, showing only the bookmarks in this file. */
  const decorate = (editor: TextEditor): void => {
    const key = uriToKey(editor.document.uri)
    for (let n = 0; n < SLOT_COUNT; n++) {
      const type = decorations.typeFor(n)
      if (!type) continue
      const bookmark = store.get(n)
      const here = bookmark && bookmark.path === key
      editor.setDecorations(type, here ? [lineRange(bookmark.line)] : [])
    }
  }

  const decorateActive = async (): Promise<void> => {
    const editor = await window.getActiveTextEditor()
    if (editor) decorate(editor)
  }

  /** Repaint visible editors showing `key` (one per editor group), or all when omitted. */
  const decorateVisible = (key?: string): void => {
    for (const editor of window.visibleTextEditors) {
      if (key !== undefined && uriToKey(editor.document.uri) !== key) continue
      decorate(editor)
    }
  }

  context.subscriptions.push(
    window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return
      lastText.set(uriToKey(editor.document.uri), editor.document.getText())
      decorate(editor)
    }),
    window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) decorate(editor)
    }),
  )

  context.subscriptions.push(
    workspace.onDidChangeTextDocument(({ document }) => {
      const key = uriToKey(document.uri)
      const previous = lastText.get(key)
      const next = document.getText()
      lastText.set(key, next)
      if (previous === undefined) return
      const result = applyDocumentChange(store, key, previous, next)
      if (!result) return
      if (result.moved) persist()
      // Tracked ranges drift when text is inserted at their start; repaint from the store.
      if (result.repaint) decorateVisible(key)
    }),
  )

  context.subscriptions.push(
    workspace.onDidOpenTextDocument((doc) => {
      lastText.set(uriToKey(doc.uri), doc.getText())
    }),
    workspace.onDidCloseTextDocument((doc) => {
      lastText.delete(uriToKey(doc.uri))
    }),
  )

  const toggle = async (slot: number): Promise<void> => {
    const editor = await window.getActiveTextEditor()
    if (!editor) return
    const key = uriToKey(editor.document.uri)
    const line = editor.selection.active.line
    const result = store.toggle(slot, key, line)
    console.info(
      `[numbered-bookmarks] toggle #${slot} @ line ${line} → ${
        result ? `set ${result.line}` : 'cleared'
      } (${key})`,
    )
    // A slot is workspace-global: setting it here can clear the ribbon in another group.
    decorateVisible()
    persist()
  }

  const jumpTo = async (bookmark: Bookmark): Promise<void> => {
    await commands.executeCommand(
      '_workbench.openFileAt',
      keyToFsPath(bookmark.path),
      bookmark.line,
      0,
    )
  }

  const jump = async (slot: number): Promise<void> => {
    const bookmark = store.get(slot)
    if (!bookmark) {
      console.info(`[numbered-bookmarks] jump #${slot}: no bookmark set`)
      return
    }
    console.info(`[numbered-bookmarks] jump #${slot} → ${bookmark.path}:${bookmark.line + 1}`)
    await jumpTo(bookmark)
  }

  for (let n = 0; n < SLOT_COUNT; n++) {
    context.subscriptions.push(
      commands.registerCommand(`numberedBookmarks.toggleBookmark${n}`, () => toggle(n)),
      commands.registerCommand(`numberedBookmarks.jumpToBookmark${n}`, () => jump(n)),
    )
  }

  context.subscriptions.push(
    commands.registerCommand('numberedBookmarks.list', () => listBookmarks(store, jumpTo)),
    commands.registerCommand('numberedBookmarks.clear', () => {
      store.clearAll()
      decorateVisible()
      persist()
    }),
  )

  // The editor list may still be filling in when we activate (onStartupFinished),
  // so paint what is visible and let the active editor cover the gap.
  decorateVisible()
  await decorateActive()

  console.info('[numbered-bookmarks] activated')
}

interface BookmarkPickItem extends QuickPickItem {
  readonly bookmark: Bookmark
}

/** Line text for `bookmark`: from the open document if available, else read from disk. */
async function previewLine(bookmark: Bookmark): Promise<string> {
  const open = workspace.textDocuments.find((d) => uriToKey(d.uri) === bookmark.path)
  if (open) {
    return (open.getText().split('\n')[bookmark.line] ?? '').trim()
  }
  try {
    const bytes = await workspace.fs.readFile(keyToFsPath(bookmark.path))
    const text = new TextDecoder().decode(bytes)
    return (text.split('\n')[bookmark.line] ?? '').trim()
  } catch {
    return ''
  }
}

async function listBookmarks(
  store: BookmarkStore,
  jumpTo: (bookmark: Bookmark) => Promise<void>,
): Promise<void> {
  const all = store.all()
  if (all.length === 0) {
    await window.showInformationMessage('No bookmarks set.')
    return
  }
  const items: BookmarkPickItem[] = await Promise.all(
    all.map(async ([slot, bookmark]) => {
      const preview = truncate((await previewLine(bookmark)) || '(empty line)', 60)
      return {
        label: `${slot} - ${preview}`,
        description: basename(bookmark.path),
        bookmark,
      }
    }),
  )
  const picked = await window.showQuickPick(items, {
    placeHolder: 'Select a bookmark to jump to',
  })
  if (!picked) return
  await jumpTo(picked.bookmark)
}

export function deactivate(): void {
  // disposables on context.subscriptions are torn down by the host
}
