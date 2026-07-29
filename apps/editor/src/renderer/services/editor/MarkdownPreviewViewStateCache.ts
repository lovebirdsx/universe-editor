/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewViewStateCache — in-memory store for a markdown preview's scroll
 *  position, keyed by source document URI. The preview editor is fully unmounted
 *  when its tab is switched away (EditorGroupView renders only the active editor),
 *  so without this the scroll position resets to the top on every return. Mirrors
 *  AcpChatViewStateCache.
 *--------------------------------------------------------------------------------------------*/

export interface MarkdownPreviewViewState {
  scrollTop: number
}

class MarkdownPreviewViewStateCacheImpl {
  private readonly _map = new Map<string, MarkdownPreviewViewState>()
  private readonly _revealLines = new Map<string, number>()
  private readonly _revealAnchors = new Map<string, string>()

  save(key: string, state: MarkdownPreviewViewState): void {
    this._map.set(key, state)
  }

  load(key: string): MarkdownPreviewViewState | undefined {
    return this._map.get(key)
  }

  /**
   * A one-shot request to scroll the preview so `line` (1-based source line) sits
   * at the top on its next mount, overriding the saved scrollTop. Used when
   * entering the preview (Ctrl+Shift+V / to the Side) so it opens aligned to the
   * source file's cursor position rather than the preview's own stale scroll.
   *
   * Read non-destructively via {@link peekRevealLine} and cleared with
   * {@link clearRevealLine} only once the request has actually been applied against
   * laid-out content — NOT on first read. The preview renders its markdown
   * asynchronously, and under React StrictMode the restore effect runs a throwaway
   * setup→cleanup cycle before the real one; a read-and-delete here would let that
   * throwaway pass (which sees no `data-line` blocks yet, so can't scroll) swallow
   * the request before the real mount ever uses it.
   */
  saveRevealLine(key: string, line: number): void {
    this._revealLines.set(key, line)
    this._revealAnchors.delete(key)
  }

  peekRevealLine(key: string): number | undefined {
    return this._revealLines.get(key)
  }

  clearRevealLine(key: string): void {
    this._revealLines.delete(key)
  }

  /**
   * A one-shot request to scroll the preview to a heading/anchor fragment on its
   * next mount, set when a cross-file link (`foo.md#section`) opens a preview
   * that isn't mounted yet. Same peek/clear contract as the reveal line — and
   * mutually exclusive with it, since both name "the" scroll target of the next
   * mount: the later request wins.
   */
  saveRevealAnchor(key: string, anchor: string): void {
    this._revealAnchors.set(key, anchor)
    this._revealLines.delete(key)
  }

  peekRevealAnchor(key: string): string | undefined {
    return this._revealAnchors.get(key)
  }

  clearRevealAnchor(key: string): void {
    this._revealAnchors.delete(key)
  }

  clear(key: string): void {
    this._map.delete(key)
    this._revealLines.delete(key)
    this._revealAnchors.delete(key)
  }

  _resetForTests(): void {
    this._map.clear()
    this._revealLines.clear()
    this._revealAnchors.clear()
  }
}

export const MarkdownPreviewViewStateCache = new MarkdownPreviewViewStateCacheImpl()
