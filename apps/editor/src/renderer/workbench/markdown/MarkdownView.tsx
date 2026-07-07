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
import { IEditorResolverService, IWorkspaceService, URI } from '@universe-editor/platform'
import { IResourceAccessService } from '../../../shared/ipc/resourceAccessService.js'
import {
  isAnchorHref,
  parseMarkdown,
  parseInline,
  slugifyHeading,
  type MdInline,
  type MdListItem,
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
  splitFilePathTarget,
} from '../../services/acp/filePathLink.js'
import { CodeBlock } from '../agents/CodeBlock.js'
import { MermaidBlock } from './MermaidBlock.js'
import { useService, useOptionalService } from '../useService.js'
import { useMarkdownFileLink, type OpenMarkdownLinkOptions } from './useMarkdownFileLink.js'
import { findMarkdownAnchor } from './markdownAnchors.js'
import { asPreviewResourceUri } from './resourceUri.js'
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
  /**
   * Custom renderer for inline images. ACP chat passes ChatImage so an embedded
   * picture (incl. base64 `data:` images an agent inlined as markdown) shows as a
   * clickable thumbnail with a preview popover. Defaults to a plain `<img>`.
   */
  readonly renderImage?: (src: string, alt: string) => ReactNode
}

export function MarkdownView({
  text,
  className,
  testId,
  baseUri,
  previewLinks,
  streaming,
  initialAnchor,
  renderImage,
}: MarkdownViewProps) {
  const nodes = useMarkdownNodes(text, streaming ?? false)
  const openFileLink = useMarkdownFileLink(baseUri, previewLinks ?? false)
  const resourceAccess = useOptionalService(IResourceAccessService)
  const workspaceFolder = useOptionalService(IWorkspaceService)?.current?.folder
  // Grant the universe-app protocol read access to the document's directory
  // and the workspace root so relative/absolute image paths inside this markdown
  // can be served. Mirrors VSCode's localResourceRoots.
  useEffect(() => {
    if (!resourceAccess) return
    const roots = [baseUri?.fsPath, workspaceFolder?.fsPath].filter(
      (p): p is string => p !== undefined,
    )
    if (roots.length > 0) void resourceAccess.allowRoots(roots)
  }, [resourceAccess, baseUri, workspaceFolder])
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollToAnchor = useMemo(
    () =>
      (anchor: string): void => {
        const root = rootRef.current
        if (!root) return
        findMarkdownAnchor(root, anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
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
        <BaseUriContext.Provider value={baseUri}>
          <InlineCodeMarkdownLinkContext.Provider value={previewLinks ?? false}>
            <ImageRenderContext.Provider value={renderImage ?? defaultRenderImage}>
              <div
                ref={rootRef}
                className={className ? `${styles['markdown']} ${className}` : styles['markdown']}
                {...(testId !== undefined ? { 'data-testid': testId } : {})}
              >
                {nodes.map((node, i) => (
                  <Block key={i} node={node} />
                ))}
              </div>
            </ImageRenderContext.Provider>
          </InlineCodeMarkdownLinkContext.Provider>
        </BaseUriContext.Provider>
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

const defaultRenderImage = (src: string, alt: string): ReactNode => (
  <img src={src} alt={alt} className={styles['mdImage']} />
)

// Injectable inline-image renderer (ACP chat swaps in ChatImage). Defaults to a
// plain <img> for docs/preview/help consumers.
const ImageRenderContext =
  createContext<(src: string, alt: string) => ReactNode>(defaultRenderImage)

// The markdown document's directory, used to resolve relative image paths to a
// loadable universe-app URL. Undefined for consumers that pass no baseUri.
const BaseUriContext = createContext<URI | undefined>(undefined)

// Scrolls to the heading whose slug matches an in-document `#anchor` link. Scoped
// per MarkdownView so an anchor only targets headings inside the same view.
const AnchorScrollContext = createContext<(id: string) => void>(() => {})

const InlineCodeMarkdownLinkContext = createContext(false)

/**
 * When provided by a parent (e.g. DocEditor), relative `.md` links are routed
 * to the handler instead of the file-system resolver. The raw href is passed
 * (e.g. `"../git/commit.md#amend"`) and the handler resolves it to a DocId.
 * `toSide` is true when Ctrl/Cmd was held, so the target opens in a new tab
 * instead of replacing the current document in place.
 */
export const DocLinkContext = createContext<
  ((href: string, opts?: { toSide?: boolean }) => void) | undefined
>(undefined)

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
            <ListItem key={i} item={item} />
          ))}
        </ol>
      ) : (
        <ul
          {...lineAttr}
          className={node.items.some((it) => it.checked !== null) ? styles['taskList'] : undefined}
        >
          {node.items.map((item, i) => (
            <ListItem key={i} item={item} />
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

/**
 * One list item: its own inline text (with an optional task-list checkbox)
 * followed by any indented child blocks (nested lists, code fences, extra
 * paragraphs …), rendered recursively via {@link Block}.
 */
function ListItem({ item }: { item: MdListItem }): ReactNode {
  return (
    <li>
      {item.checked !== null && (
        <input type="checkbox" readOnly checked={item.checked} className={styles['taskCheckbox']} />
      )}
      {renderInline(item.inline)}
      {item.children?.map((child, i) => (
        <Block key={i} node={child} />
      ))}
    </li>
  )
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
      return <InlineImage src={node.src} alt={node.alt} />
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

function InlineImage({ src, alt }: { src: string; alt: string }) {
  const renderImage = useContext(ImageRenderContext)
  const baseUri = useContext(BaseUriContext)
  const workspaceRoot = useOptionalService(IWorkspaceService)?.current?.folder
  const resolved = asPreviewResourceUri(src, baseUri, workspaceRoot)
  if (resolved === undefined) return null
  return <>{renderImage(resolved, alt)}</>
}

// In preview surfaces, inline code that is exactly `[label](href)` renders as
// the same safe link the normal markdown parser would emit. Inline code that is
// exactly one file path also becomes a clickable monospace link (the common
// case: agents/docs wrap paths in backticks). Anything else stays a plain
// `<code>` so prose and snippets are unaffected.
function InlineCode({ text }: { text: string }) {
  const openFileLink = useContext(FileLinkContext)
  const renderMarkdownLink = useContext(InlineCodeMarkdownLinkContext)
  const link = renderMarkdownLink ? parseInlineCodeMarkdownLink(text) : undefined
  if (link) return <SafeLink href={link.href}>{renderInline(link.children)}</SafeLink>

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

function parseInlineCodeMarkdownLink(
  text: string,
): { href: string; children: readonly MdInline[] } | undefined {
  if (!text.startsWith('[')) return undefined
  const nodes = parseInline(text)
  if (nodes.length !== 1) return undefined
  const node = nodes[0]
  if (node?.type !== 'link') return undefined
  return { href: node.href, children: node.children }
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
      scrollToAnchor(href)
      return
    }
    // Doc-to-doc relative link: intercept before file-path resolution.
    if (isRelativeDocLink && openDocLink) {
      openDocLink(href, { toSide: e.ctrlKey || e.metaKey })
      return
    }
    if (isFilePath) {
      const { path, line, col, fragment } = splitFilePathTarget(href)
      openFileLink(path, line, col, {
        toSide: e.ctrlKey || e.metaKey,
        // Ctrl+Alt opens a directory target in the current window (preview only).
        openFolderInCurrentWindow: (e.ctrlKey || e.metaKey) && e.altKey,
        ...(fragment !== undefined ? { fragment } : {}),
      })
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
