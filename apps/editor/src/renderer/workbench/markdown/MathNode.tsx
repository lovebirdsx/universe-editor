/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Math nodes for the markdown renderer. KaTeX output is trusted HTML (see the
 *  security note in mathRenderer.ts) and therefore inserted with
 *  dangerouslySetInnerHTML. The renderer loads lazily; until it resolves — or
 *  when the consumer disabled math — the raw TeX is shown instead.
 *
 *  Inline math stays a <span> even in display mode: a <div> inside a <p> is
 *  invalid HTML and React would warn. The block variant owns a <div> because it
 *  is emitted at block level by the parser.
 *--------------------------------------------------------------------------------------------*/

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { MathLoader, type MathRenderer } from './mathLoader.js'
import { EMPTY_MATH_MACROS } from './mathOptions.js'
import styles from './markdown.module.css'

export interface MathOptions {
  readonly enabled: boolean
  readonly macros: Readonly<Record<string, string>>
}

/** Defaults make every MarkdownView consumer math-aware without opt-in. */
export const MathOptionsContext = createContext<MathOptions>({
  enabled: true,
  macros: EMPTY_MATH_MACROS,
})

/** Rendered HTML for one formula, or undefined while loading / disabled / failed. */
function useMathHtml(tex: string, display: boolean): string | undefined {
  const { enabled, macros } = useContext(MathOptionsContext)
  const [renderer, setRenderer] = useState<MathRenderer | undefined>(() => MathLoader.getLoaded())

  useEffect(() => {
    if (!enabled || renderer !== undefined) return
    let cancelled = false
    void MathLoader.ensureInitialized()
      .then((loaded) => {
        if (!cancelled) setRenderer(() => loaded)
      })
      .catch(() => {
        // Chunk load failed; keep showing the raw TeX. MathLoader resets its
        // promise, so a later mount retries.
      })
    return () => {
      cancelled = true
    }
  }, [enabled, renderer])

  return useMemo(() => {
    if (!enabled || renderer === undefined) return undefined
    const html = renderer(tex, display, macros)
    return html.length > 0 ? html : undefined
  }, [enabled, renderer, tex, display, macros])
}

function MathFallback({ tex }: { readonly tex: string }): ReactNode {
  return <span className={styles['mathFallback']}>{tex}</span>
}

/** Mid-paragraph formula: always an inline-level element, whatever the display mode. */
export const MathInlineNode = memo(function MathInlineNode({
  tex,
  display,
}: {
  readonly tex: string
  readonly display: boolean
}): ReactNode {
  const html = useMathHtml(tex, display)
  return (
    <span
      className={display ? styles['mathDisplayInline'] : styles['mathInline']}
      data-testid="md-math-inline"
      {...(display ? { 'data-math-display': 'true' } : {})}
      {...(html !== undefined ? { dangerouslySetInnerHTML: { __html: html } } : {})}
    >
      {html === undefined ? <MathFallback tex={tex} /> : null}
    </span>
  )
})

/** Standalone `$$…$$` block (also used for ```math fences). */
export const MathBlockNode = memo(function MathBlockNode({
  tex,
  line,
}: {
  readonly tex: string
  readonly line?: number
}): ReactNode {
  const html = useMathHtml(tex, true)
  return (
    <div
      className={styles['mathBlock']}
      data-testid="md-math-block"
      {...(line !== undefined ? { 'data-line': line } : {})}
    >
      {html !== undefined ? (
        <span className={styles['mathBlockContent']} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <MathFallback tex={tex} />
      )}
    </div>
  )
})
