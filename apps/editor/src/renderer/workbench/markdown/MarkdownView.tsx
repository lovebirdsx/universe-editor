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
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { IWorkspaceService, URI } from '@universe-editor/platform'
import { IResourceAccessService } from '../../../shared/ipc/resourceAccessService.js'
import {
  inlineToText,
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
import { setHeapGauge } from '../../services/memory/heapFlowCounters.js'
import { MermaidBlock } from './MermaidBlock.js'
import { MarkdownStreamingContext } from './markdownStreamingContext.js'
import { useOptionalService } from '../useService.js'
import { useMarkdownFileLink, type OpenMarkdownLinkOptions } from './useMarkdownFileLink.js'
import { fileUriLinkTarget } from './markdownLinkResolve.js'
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
  /**
   * How to render a leading YAML `---` frontmatter block. `'table'` shows it as
   * a GitHub-style key/value table; `'hidden'` drops it. Undefined (the default)
   * treats `---` as a normal horizontal rule — the behaviour for ACP chat and
   * other consumers that don't want frontmatter awareness. Only the doc preview
   * passes this, driven by the `markdown.preview.renderYamlFrontmatter` setting.
   */
  readonly frontmatter?: 'table' | 'hidden'
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
  frontmatter,
}: MarkdownViewProps) {
  const { nodes, sealedNodes, tailChars } = useMarkdownNodes(
    text,
    streaming ?? false,
    frontmatter !== undefined,
  )
  // Absolute readings for the heap report: node counts are what move when a growing
  // message re-renders, and they are invisible to the V8 heap number.
  useEffect(() => {
    setHeapGauge('astnodes', nodes.length)
    setHeapGauge('sealednodes', sealedNodes.length)
    setHeapGauge('tailchars', tailChars)
  })
  const openFileLink = useMarkdownFileLink(baseUri, previewLinks ?? false)
  const resourceAccess = useOptionalService(IResourceAccessService)
  const workspaceFolder = useOptionalService(IWorkspaceService)?.current?.folder
  // Grant the universe-app protocol read access to the document's directory
  // and the workspace root so relative/absolute image paths inside this markdown
  // can be served. Mirrors VSCode's localResourceRoots.
  useEffect(() => {
    if (!resourceAccess) return
    // 本机路径，不随远端工作区变化：universe-app 协议只服务本机文件。
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
    const id = setTimeout(() => scrollToAnchor(anchor), 50)
    return () => clearTimeout(id)
  }, [scrollToAnchor])

  return (
    <FileLinkContext.Provider value={openFileLink}>
      <AnchorScrollContext.Provider value={scrollToAnchor}>
        <BaseUriContext.Provider value={baseUri}>
          <InlineCodeMarkdownLinkContext.Provider value={previewLinks ?? false}>
            <ImageRenderContext.Provider value={renderImage ?? defaultRenderImage}>
              <FrontmatterModeContext.Provider value={frontmatter}>
                <div
                  ref={rootRef}
                  className={className ? `${styles['markdown']} ${className}` : styles['markdown']}
                  {...(testId !== undefined ? { 'data-testid': testId } : {})}
                >
                  {streaming ? (
                    <>
                      <SealedNodes nodes={sealedNodes} />
                      <MarkdownStreamingContext.Provider value={true}>
                        <TailNodes nodes={nodes} from={sealedNodes.length} />
                      </MarkdownStreamingContext.Provider>
                    </>
                  ) : (
                    nodes.map((node, i) => <MemoBlock key={i} node={node} />)
                  )}
                </div>
              </FrontmatterModeContext.Provider>
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
 *
 * `sealedNodes` is the cache's own prefix array, holding the same element objects
 * that head `nodes`. Keeping that identity across renders is what lets the sealed
 * half skip reconciliation entirely; handing React `nodes.slice(0, n)` instead
 * would allocate a fresh array every frame and lose the whole win.
 *
 * The cache is read on the static branch too: a sealed message renders through
 * plain `parseMarkdown`, but the sealing progress it reached is what the `gauge=`
 * readings report, and reporting 0 once a stream ends would say "nothing was ever
 * sealed" about the very stream the reading exists for.
 */
function useMarkdownNodes(
  text: string,
  streaming: boolean,
  frontmatter: boolean,
): {
  readonly nodes: readonly MdNode[]
  readonly sealedNodes: readonly MdNode[]
  /** Characters still unsealed — the part every batch has to re-parse and re-render. */
  readonly tailChars: number
} {
  const cacheRef = useRef(createMarkdownStreamCache())
  const staticNodes = useMemo(
    () => (streaming ? undefined : parseMarkdown(text, { frontmatter })),
    [text, streaming, frontmatter],
  )
  const cache = cacheRef.current
  if (staticNodes !== undefined) {
    return {
      nodes: staticNodes,
      sealedNodes: cache.sealedNodes,
      tailChars: text.length - cache.sealedText.length,
    }
  }
  const nodes = parseMarkdownStreaming(text, cache)
  return { nodes, sealedNodes: cache.sealedNodes, tailChars: text.length - cache.sealedText.length }
}

// Also consumed by MessageContent's plaintext variant: bare file paths in user
// prompts render as links driven by the same openFileLink pipeline.
export const FileLinkContext = createContext<
  (
    path: string,
    line?: number,
    col?: number,
    endLine?: number,
    opts?: OpenMarkdownLinkOptions,
  ) => void
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

// True while rendering the children of an anchor (SafeLink). Nested interactive
// inline renderers (FilePathLink, inline-code links) must demote to plain
// output — a nested <a> is invalid HTML and React logs a hydration error.
const InsideLinkContext = createContext(false)

// How the preview should render a frontmatter node ('table' | 'hidden'). Only
// set by the doc preview; undefined elsewhere (no frontmatter node is produced).
const FrontmatterModeContext = createContext<'table' | 'hidden' | undefined>(undefined)

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
        <CodeFenceBlock node={node} />
      )
    case 'list':
      return node.ordered ? (
        <ol
          {...lineAttr}
          {...(node.start !== undefined && node.start !== 1 ? { start: node.start } : {})}
        >
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
      return (
        <blockquote {...lineAttr}>
          {node.children.map((child, i) => (
            <Block key={i} node={child} />
          ))}
        </blockquote>
      )
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
    case 'frontmatter':
      return <FrontmatterBlock node={node} lineAttr={lineAttr} />
  }
}

const MemoBlock = memo(Block)

/**
 * The sealed prefix of a streaming message: parsed once, then reused verbatim.
 * Its `nodes` array keeps its identity between seals, so a growing tail — which
 * re-renders ~60x/s during a thought storm — costs this subtree nothing.
 */
const SealedNodes = memo(function SealedNodes({ nodes }: { readonly nodes: readonly MdNode[] }) {
  return (
    <>
      {nodes.map((node, i) => (
        <MemoBlock key={i} node={node} />
      ))}
    </>
  )
})

/**
 * The unsealed tail, re-parsed and re-rendered on every batch by design. A node
 * that seals migrates into {@link SealedNodes}, which remounts its subtree — a
 * text selection inside it does not survive a seal.
 */
function TailNodes({ nodes, from }: { readonly nodes: readonly MdNode[]; from: number }) {
  return (
    <>
      {nodes.slice(from).map((node, i) => (
        <MemoBlock key={from + i} node={node} />
      ))}
    </>
  )
}

/**
 * A non-mermaid code fence. Wraps {@link CodeBlock} so it can read the file-link
 * opener from context and turn bare paths inside the block into clickable links.
 */
function CodeFenceBlock({ node }: { node: Extract<MdNode, { type: 'code_fence' }> }): ReactNode {
  const openFileLink = useContext(FileLinkContext)
  return (
    <CodeBlock
      code={node.code}
      lang={node.lang}
      onOpenFilePath={openFileLink}
      {...(node.line !== undefined ? { line: node.line } : {})}
    />
  )
}

/**
 * key/value table; in `'hidden'` mode (or when no mode is provided) it renders
 * nothing. Values keep their raw text — no inline markdown parsing — since
 * frontmatter is data, not prose.
 */
function FrontmatterBlock({
  node,
  lineAttr,
}: {
  node: Extract<MdNode, { type: 'frontmatter' }>
  lineAttr: Record<string, unknown>
}): ReactNode {
  const mode = useContext(FrontmatterModeContext)
  if (mode !== 'table' || node.entries.length === 0) return null
  return (
    <table {...lineAttr} className={styles['frontmatterTable']}>
      <tbody>
        {node.entries.map(([key, value], i) => (
          <tr key={i}>
            <th scope="row">{key}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
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
          {...(node.endLine !== undefined ? { endLine: node.endLine } : {})}
        />
      )
    case 'link':
      return <SafeLink href={node.href}>{renderInline(node.children)}</SafeLink>
    case 'anchor':
      // Zero-footprint in-document anchor target, addressed by #id links the same
      // way as heading slugs (see findMarkdownAnchor). data-anchor is set verbatim
      // (no slugify) so exact id matching works; the slug fallback lives in
      // findMarkdownAnchor.
      return <span data-anchor={node.id} className={styles['mdAnchor']} />
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
  const insideLink = useContext(InsideLinkContext)
  const renderMarkdownLink = useContext(InlineCodeMarkdownLinkContext)
  const link = renderMarkdownLink && !insideLink ? parseInlineCodeMarkdownLink(text) : undefined
  if (link) return <SafeLink href={link.href}>{renderInline(link.children)}</SafeLink>

  const match = matchFullFilePath(text)
  if (!match || insideLink) return <code className={styles['inlineCode']}>{text}</code>
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    openFileLink(match.path, match.line, match.col, match.endLine, {
      toSide: e.ctrlKey || e.metaKey,
    })
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
      const { path, line, col, endLine, fragment } = splitFilePathTarget(href)
      openFileLink(path, line, col, endLine, {
        toSide: e.ctrlKey || e.metaKey,
        // Ctrl+Alt opens a directory target in the current window (preview only).
        openFolderInCurrentWindow: (e.ctrlKey || e.metaKey) && e.altKey,
        ...(fragment !== undefined ? { fragment } : {}),
      })
      return
    }
    if (isFile) {
      // Route through the same file-link pipeline as plain path links so a
      // directory target opens as a folder window and a markdown target can
      // open as a preview — not blindly into the editor resolver.
      const target = fileUriLinkTarget(href)
      if (target) {
        openFileLink(target.path, target.line, target.col, target.endLine, {
          toSide: e.ctrlKey || e.metaKey,
          openFolderInCurrentWindow: (e.ctrlKey || e.metaKey) && e.altKey,
          ...(target.fragment !== undefined ? { fragment: target.fragment } : {}),
        })
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
      <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
    </a>
  )
}

function FilePathLink({
  path,
  line,
  col,
  endLine,
}: {
  path: string
  line?: number
  col?: number
  endLine?: number
}) {
  const openFileLink = useContext(FileLinkContext)
  const insideLink = useContext(InsideLinkContext)
  const label =
    line !== undefined
      ? `${path}:${line}${col !== undefined ? `:${col}` : endLine !== undefined ? `-${endLine}` : ''}`
      : path
  // Inside another anchor the outer link already owns the click; a nested <a>
  // would be invalid HTML, so render as plain text.
  if (insideLink) return <Fragment>{label}</Fragment>
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    openFileLink(path, line, col, endLine, { toSide: e.ctrlKey || e.metaKey })
  }
  return (
    <a href={label} onClick={onClick} className={styles['mdLink']} data-testid="md-filepath">
      {label}
    </a>
  )
}
