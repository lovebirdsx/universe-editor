import {
  OverviewRulerLane,
  window,
  type TextEditorDecorationType,
} from '@universe-editor/extension-api'
import { SLOT_COUNT } from './bookmarks.js'

export interface DecorationColors {
  readonly fill: string
  readonly number: string
}

/**
 * An inline SVG, encoded as a data-URI, of a bookmark tag (a ribbon with a
 * notched foot) carrying the bookmark's digit — painted in the editor's glyph
 * margin. Generated at runtime so the fill/number colors follow user
 * configuration without shipping 10 PNGs.
 */
function gutterIconDataUri(digit: number, colors: DecorationColors): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<path d="M3 1 H13 V15 L8 11.5 L3 15 Z" fill="${colors.fill}"/>` +
    `<text x="8" y="9" font-family="monospace" font-size="9" font-weight="bold" ` +
    `text-anchor="middle" fill="${colors.number}">${digit}</text>` +
    `</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/**
 * Owns one decoration type per bookmark slot (0-9). Created lazily and rebuilt
 * when colors change, so switching themes/config re-paints with fresh icons.
 * Dispose tears down every type.
 */
export class DecorationProvider {
  private types: TextEditorDecorationType[] = []
  private colors: DecorationColors | undefined

  /** (Re)build the 10 decoration types for `colors` if they changed. */
  ensure(colors: DecorationColors): void {
    if (
      this.colors &&
      this.colors.fill === colors.fill &&
      this.colors.number === colors.number &&
      this.types.length === SLOT_COUNT
    ) {
      return
    }
    this.dispose()
    this.colors = colors
    this.types = Array.from({ length: SLOT_COUNT }, (_, digit) =>
      window.createTextEditorDecorationType({
        gutterIconPath: gutterIconDataUri(digit, colors),
        isWholeLine: true,
        overviewRulerColor: colors.fill,
        overviewRulerLane: OverviewRulerLane.Full,
      }),
    )
  }

  typeFor(slot: number): TextEditorDecorationType | undefined {
    return this.types[slot]
  }

  dispose(): void {
    for (const t of this.types) t.dispose()
    this.types = []
    this.colors = undefined
  }
}
