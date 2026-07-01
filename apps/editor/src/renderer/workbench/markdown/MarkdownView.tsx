/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownView — render a markdown string as React elements via the shared
 *  `parseMarkdown` AST. No raw HTML is emitted from user text (React escapes
 *  text nodes); only Monaco-colorized code (trusted, escaped) uses innerHTML,
 *  inside CodeBlock. Font size / colour are inherited from the container so the
 *  same component fits both the compact ACP chat and the roomier doc preview.
 *--------------------------------------------------------------------------------------------*/

import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { IEditorResolverService, URI } from '@universe-editor/platform'
import {
  isAnchorHref,
  parseMarkdown,
  slugifyHeading,
  type MdInline,
  type MdNode,
  type TableAlign,
} from '../../services/acp/markdownRenderer.js'
import {
  createMarkdownStreamCache,
  parseMarkdownStreaming,
} from '../../services/acp/markdownIncremental.js'
import {
  looksLikeFilePath,
  matchFullFilePath,
  splitFilePathLocation,
} from '../../services/acp/filePathLink.js'
import { CodeBlock } from '../agents/CodeBlock.js'
import { MermaidBlock } from './MermaidBlock.js'
import { useService } from '../useService.js'
import { useMarkdownFileLink, type OpenMarkdownLinkOptions } from './useMarkdownFileLink.js'
import styles from './markdown.module.css'

interface MarkdownViewProps {
  readonly text: string
  readonly className?: string
  readonly testId?: string
  /** Base URI for resolving relative file-path links (markdown source dir or workspace root). */
  readonly baseUri?: URI
  /**
   * When true, links to other markdown files open as a preview (in place on
   * click, in a new tab on Ctrl/Cmd+click) rather than their source editor.
   * Enabled by the doc preview; off for ACP chat and other static consumers.
   */
  readonly previewLinks?: boolean
  /**
   * When true the text is the live tail of a streaming agent message that grows
   * one chunk at a time; parse it incrementally (sealed-prefix cache) instead of
   * re-parsing the whole accumulated string on every chunk. Off by default for
   * static consumers (doc preview, release notes, help), which keep the simple
   * memoized full parse.
   */
  readonly streaming?: boolean
  /**
   * Anchor slug to scroll into view after the first render. Used by DocEditor to
   * implement cross-document `[text](./other.md#section)` navigation.
   */
  readonly initialAnchor?: string
}

export function MarkdownView({
  text,
  className,
  testId,
  baseUri,
  previewLinks,
  streaming,
  initialAnchor,
}: MarkdownViewProps) {
  const nodes = useMarkdownNodes(text, streaming ?? false)
  const openFileLink = useMarkdownFileLink(baseUri, previewLinks ?? false)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollToAnchor = useMemo(
    () =>
      (id: string): void => {
        const root = rootRef.current
        if (!root) return
        const target = root.querySelector(`[data-anchor="${cssEscape(id)}"]`)
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      },
    [],
  )

  // Scroll to a cross-document anchor after the headings are rendered.
  const initialAnchorRef = useRef(initialAnchor)
  useEffect(() => {
    const anchor = initialAnchorRef.current
    if (!anchor) return
    const id = setTimeout(() => scrollToAnchor(slugifyHeading(anchor)), 50)
    return () => clearTimeout(id)
  }, [scrollToAnchor])

  return (
    <FileLinkContext.Provider value={openFileLink}>
      <AnchorScrollContext.Provider value={scrollToAnchor}>
        <div
          ref={rootRef}
          className={className ? `${styles['markdown']} ${className}` : styles['markdown']}
          {...(testId !== undefined ? { 'data-testid': testId } : {})}
        >
          {nodes.map((node, i) => (
            <Block key={i} node={node} />
          ))}
        </div>
      </AnchorScrollContext.Provider>
    </FileLinkContext.Provider>
  )
}

/**
 * Parse markdown to nodes, incrementally when `streaming`. The incremental cache
 * lives in a ref tied to this component instance; it self-heals if the text ever
 * diverges from the cached prefix (message reset / non-monotonic growth).
 */
function useMarkdownNodes(text: string, streaming: boolean): readonly MdNode[] {
  const cacheRef = useRef(createMarkdownStreamCache())
  const staticNodes = useMemo(
    () => (streaming ? undefined : parseMarkdown(text)),
    [text, streaming],
  )
  if (staticNodes !== undefined) return staticNodes
  return parseMarkdownStreaming(text, cacheRef.current)
}

const FileLinkContext = createContext<
  (path: string, line?: number, col?: number, opts?: OpenMarkdownLinkOptions) => void
>(() => {})

// Scrolls to the heading whose slug matches an in-document `#anchor` link. Scoped
// per MarkdownView so an anchor only targets headings inside the same view.
const AnchorScrollContext = createContext<(id: string) => void>(() => {})

/**
 * When provided by a parent (e.g. DocEditor), relative `.md` links are routed
 * to the handler instead of the file-system resolver. The raw href is passed
 * (e.g. `"../git/commit.md#amend"`) and the handler resolves it to a DocId.
 */
export const DocLinkContext = createContext<((href: string) => void) | undefined>(undefined)

/** Quote an attribute value for a querySelector, falling back to a manual escape. */
function cssEscape(value: string): string {
  const esc = (globalThis.CSS as { escape?: (v: string) => string } | undefined)?.escape
  return esc ? esc(value) : value.replace(/["\\]/g, '\\$&')
}

// Normalize an `#anchor` href to a heading slug: strip `#`, URL-decode (authors
// may percent-encode CJK), then apply the same slug rules used for heading ids,
// so casing/encoding differences still resolve.
function decodeAnchor(href: string): string {
  const raw = href.slice(1)
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // Malformed %-escape — fall back to the raw fragment.
  }
  return slugifyHeading(decoded)
}

function Block({ node }: { node: MdNode }): ReactNode {
  const lineAttr = node.line !== undefined ? { 'data-line': node.line } : {}
  switch (node.type) {
    case 'paragraph':
      return <p {...lineAttr}>{renderInline(node.children)}</p>
    case 'heading': {
      const Tag = `h${node.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      const anchor = slugifyHeading(inlineToText(node.children))
      return (
        <Tag {...lineAttr} {...(anchor ? { 'data-anchor': anchor } : {})}>
          {renderInline(node.children)}
        </Tag>
      )
    }
    case 'code_fence':
      return node.lang?.toLowerCase() === 'mermaid' ? (
        <MermaidBlock code={node.code} />
      ) : (
        <CodeBlock
          code={node.code}
          lang={node.lang}
          {...(node.line !== undefined ? { line: node.line } : {})}
        />
      )
    case 'list':
      return node.ordered ? (
        <ol {...lineAttr}>
          {node.items.map((item, i) => (
            <li key={i}>
              {item.checked !== null && (
                <input
                  type="checkbox"
                  readOnly
                  checked={item.checked}
                  className={styles['taskCheckbox']}
                />
              )}
              {renderInline(item.inline)}
            </li>
          ))}
        </ol>
      ) : (
        <ul
          {...lineAttr}
          className={node.items.some((it) => it.checked !== null) ? styles['taskList'] : undefined}
        >
          {node.items.map((item, i) => (
            <li key={i}>
              {item.checked !== null && (
                <input
                  type="checkbox"
                  readOnly
                  checked={item.checked}
                  className={styles['taskCheckbox']}
                />
              )}
              {renderInline(item.inline)}
            </li>
          ))}
        </ul>
      )
    case 'blockquote':
      return <blockquote {...lineAttr}>{renderInline(node.children)}</blockquote>
    case 'table':
      return (
        <table {...lineAttr}>
          <thead>
            <tr>
              {node.header.map((cell, c) => (
                <th key={c} style={alignStyle(node.align[c])}>
                  {renderInline(cell)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} style={alignStyle(node.align[c])}>
                    {renderInline(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'hr':
      return <hr {...lineAttr} />
  }
}

function alignStyle(align: TableAlign | null | undefined): React.CSSProperties | undefined {
  return align ? { textAlign: align } : undefined
}

function renderInline(nodes: readonly MdInline[]): ReactNode {
  return nodes.map((n, i) => <InlineNode key={i} node={n} />)
}

/** Flatten inline nodes to their visible text, for computing a heading's slug. */
function inlineToText(nodes: readonly MdInline[]): string {
  let out = ''
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
      case 'code':
        out += n.text
        break
      case 'bold':
      case 'italic':
      case 'strike':
      case 'link':
        out += inlineToText(n.children)
        break
      case 'filepath':
        out += n.path
        break
    }
  }
  return out
}

function InlineNode({ node }: { node: MdInline }): ReactNode {
  switch (node.type) {
    case 'text':
      return <Fragment>{node.text}</Fragment>
    case 'bold':
      return <strong>{renderInline(node.children)}</strong>
    case 'italic':
      return <em>{renderInline(node.children)}</em>
    case 'strike':
      return <del>{renderInline(node.children)}</del>
    case 'code':
      return <InlineCode text={node.text} />
    case 'image':
      return <img src={node.src} alt={node.alt} className={styles['mdImage']} />
    case 'softbreak':
      return <Fragment>{'\n'}</Fragment>
    case 'filepath':
      return (
        <FilePathLink
          path={node.path}
          {...(node.line !== undefined ? { line: node.line } : {})}
          {...(node.col !== undefined ? { col: node.col } : {})}
        />
      )
    case 'link':
      return <SafeLink href={node.href}>{renderInline(node.children)}</SafeLink>
  }
}

// Inline code that is exactly one file path becomes a clickable monospace link
// (the common case: agents/docs wrap paths in backticks). Anything else stays a
// plain `<code>` so prose and snippets are unaffected.
function InlineCode({ text }: { text: string }) {
  const openFileLink = useContext(FileLinkContext)
  const match = matchFullFilePath(text)
  if (!match) return <code className={styles['inlineCode']}>{text}</code>
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    openFileLink(match.path, match.line, match.col, { toSide: e.ctrlKey || e.metaKey })
  }
  return (
    <a
      href={text}
      onClick={onClick}
      className={`${styles['inlineCode']} ${styles['mdLink']}`}
      data-testid="md-filepath"
    >
      {text}
    </a>
  )
}

function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  const editorResolver = useService(IEditorResolverService)
  const openFileLink = useContext(FileLinkContext)
  const scrollToAnchor = useContext(AnchorScrollContext)
  const openDocLink = useContext(DocLinkContext)
  const isAnchor = isAnchorHref(href)
  const isFile = href.startsWith('file:')
  const isFilePath = !isFile && !isAnchor && looksLikeFilePath(href)
  // A relative doc link: starts with ./ or ../ and the path portion ends in .md
  const isRelativeDocLink =
    openDocLink !== undefined && /^\.\.?\//.test(href) && /\.md(#[^#]*)?$/.test(href)
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    if (isAnchor) {
      scrollToAnchor(decodeAnchor(href))
      return
    }
    // Doc-to-doc relative link: intercept before file-path resolution.
    if (isRelativeDocLink && openDocLink) {
      openDocLink(href)
      return
    }
    if (isFilePath) {
      const { path, line, col } = splitFilePathLocation(href)
      openFileLink(path, line, col, { toSide: e.ctrlKey || e.metaKey })
      return
    }
    if (isFile) {
      try {
        const uri = URI.parse(href)
        void editorResolver.openEditor(uri)
      } catch {
        // Malformed URI — silently ignore so untrusted input can't crash render.
      }
      return
    }
    // External URL: let Electron's window-open handler take it. If unhandled,
    // the call is a no-op (better than navigating the renderer view).
    window.open(href, '_blank', 'noopener,noreferrer')
  }
  return (
    <a
      href={href}
      onClick={onClick}
      target={isFile || isFilePath || isAnchor || isRelativeDocLink ? undefined : '_blank'}
      rel="noopener noreferrer"
      className={styles['mdLink']}
    >
      {children}
    </a>
  )
}

function FilePathLink({ path, line, col }: { path: string; line?: number; col?: number }) {
  const openFileLink = useContext(FileLinkContext)
  const label = line !== undefined ? `${path}:${line}${col !== undefined ? `:${col}` : ''}` : path
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    openFileLink(path, line, col, { toSide: e.ctrlKey || e.metaKey })
  }
  return (
    <a href={label} onClick={onClick} className={styles['mdLink']} data-testid="md-filepath">
      {label}
    </a>
  )
}
