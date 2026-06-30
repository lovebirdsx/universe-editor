/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownView — render a markdown string as React elements via the shared
 *  `parseMarkdown` AST. No raw HTML is emitted from user text (React escapes
 *  text nodes); only Monaco-colorized code (trusted, escaped) uses innerHTML,
 *  inside CodeBlock. Font size / colour are inherited from the container so the
 *  same component fits both the compact ACP chat and the roomier doc preview.
 *--------------------------------------------------------------------------------------------*/

import { createContext, Fragment, useContext, useMemo, useRef, type ReactNode } from 'react'
import { IEditorResolverService, URI } from '@universe-editor/platform'
import {
  parseMarkdown,
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
}

export function MarkdownView({
  text,
  className,
  testId,
  baseUri,
  previewLinks,
  streaming,
}: MarkdownViewProps) {
  const nodes = useMarkdownNodes(text, streaming ?? false)
  const openFileLink = useMarkdownFileLink(baseUri, previewLinks ?? false)
  return (
    <FileLinkContext.Provider value={openFileLink}>
      <div
        className={className ? `${styles['markdown']} ${className}` : styles['markdown']}
        {...(testId !== undefined ? { 'data-testid': testId } : {})}
      >
        {nodes.map((node, i) => (
          <Block key={i} node={node} />
        ))}
      </div>
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

function Block({ node }: { node: MdNode }): ReactNode {
  const lineAttr = node.line !== undefined ? { 'data-line': node.line } : {}
  switch (node.type) {
    case 'paragraph':
      return <p {...lineAttr}>{renderInline(node.children)}</p>
    case 'heading': {
      const Tag = `h${node.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return <Tag {...lineAttr}>{renderInline(node.children)}</Tag>
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
  const isFile = href.startsWith('file:')
  const isFilePath = !isFile && looksLikeFilePath(href)
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
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
      target={isFile || isFilePath ? undefined : '_blank'}
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
