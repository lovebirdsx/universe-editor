/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownView — render a markdown string as React elements via the shared
 *  `parseMarkdown` AST. No raw HTML is emitted from user text (React escapes
 *  text nodes); only Monaco-colorized code (trusted, escaped) and KaTeX math
 *  output (trusted, see mathRenderer.ts) use innerHTML. Font size / colour are
 *  inherited from the container so the same component fits both the compact ACP
 *  chat and the roomier doc preview.
 *--------------------------------------------------------------------------------------------*/

import {
  createContext,
  Fragment,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { IConfigurationService, IWorkspaceService, URI } from '@universe-editor/platform'
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
  type ParseMarkdownOptions,
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
import { registerHeapView, unregisterHeapView } from '../../services/memory/heapFlowCounters.js'
import { MermaidBlock } from './MermaidBlock.js'
import { MathBlockNode, MathInlineNode, MathOptionsContext } from './MathNode.js'
import { EMPTY_MATH_MACROS, sanitizeMathMacros } from './mathOptions.js'
import { MarkdownStreamingContext } from './markdownStreamingContext.js'
import { useOptionalService } from '../useService.js'
import { useMarkdownFileLink, type OpenMarkdownLinkOptions } from './useMarkdownFileLink.js'
import {
  isOpenTargetEnter,
  resolveOpenTarget,
  type OpenTarget,
} from '../../services/editor/openTarget.js'
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
   * click, in the side group on Ctrl/Cmd+click, in an auxiliary window on
   * Alt+click) rather than their source editor. Enabled by the doc preview; off
   * for ACP chat and other static consumers.
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
  /**
   * Whether LaTeX math is rendered. Omitted = enabled, so chat/docs/release
   * notes opt in by default; only the file preview turns it off, driven by
   * `markdown.math.enabled`.
   */
  readonly math?: boolean
  /**
   * User-defined KaTeX macros (`markdown.math.macros`). MarkdownView reads the
   * live setting itself so chat/docs/preview all agree; passing this prop
   * overrides the setting for tests and embedders outside the workbench.
   */
  readonly mathMacros?: Readonly<Record<string, string>>
  /**
   * Additional explicit-link schemes (`[label](doc:x)`) this consumer accepts.
   * Empty by default: ACP chat, docs and previews keep treating unknown schemes
   * as literal text.
   */
  readonly extraHrefSchemes?: readonly string[]
  /**
   * Takes over link activation for the consumers that own their own navigation
   * (release notes). Returning true consumes the click. Declining an href is
   * NOT a fallback to the file/external handling: outside http(s)/anchors the
   * handler is the only path, so a controlled scheme can never reach
   * `window.open` or the file opener by accident.
   */
  readonly linkHandler?: MarkdownLinkHandler
}

/** Return true to consume the click; false lets http(s)/anchor links use the defaults. */
export type MarkdownLinkHandler = (href: string, opts: { readonly target: OpenTarget }) => boolean

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
  math,
  mathMacros,
  extraHrefSchemes,
  linkHandler,
}: MarkdownViewProps) {
  // Identity of the scheme list drives the parse memo; the array prop itself is
  // usually an inline literal, so comparing references would re-parse forever.
  const schemesKey =
    extraHrefSchemes !== undefined && extraHrefSchemes.length > 0 ? extraHrefSchemes.join(',') : ''
  const mathEnabled = math !== false
  const macros = useMathMacros(mathMacros)
  const mathOptions = useMemo(() => ({ enabled: mathEnabled, macros }), [mathEnabled, macros])
  const { nodes, sealedNodes, tailChars } = useMarkdownNodes(
    text,
    streaming ?? false,
    frontmatter !== undefined,
    schemesKey,
    mathEnabled,
  )
  // Absolute readings for the heap report: node counts are what move when a growing
  // message re-renders, and they are invisible to the V8 heap number. Registered
  // per view and summed on read — several chat panels are typically mounted at once,
  // and a last-writer-wins gauge would report whichever one rendered last.
  const heapGauges = useMemo(
    () => ({
      astnodes: nodes.length,
      sealednodes: sealedNodes.length,
      tailchars: tailChars,
      mdbytes: text.length,
    }),
    [nodes.length, sealedNodes.length, tailChars, text.length],
  )
  useEffect(() => {
    const id = registerHeapView(heapGauges)
    return () => unregisterHeapView(id)
  }, [heapGauges])
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
    <MathOptionsContext.Provider value={mathOptions}>
      <FileLinkContext.Provider value={openFileLink}>
        <AnchorScrollContext.Provider value={scrollToAnchor}>
          <BaseUriContext.Provider value={baseUri}>
            <InlineCodeMarkdownLinkContext.Provider value={previewLinks ?? false}>
              <ImageRenderContext.Provider value={renderImage ?? defaultRenderImage}>
                <FrontmatterModeContext.Provider value={frontmatter}>
                  <LinkHandlerContext.Provider value={linkHandler}>
                    <div
                      ref={rootRef}
                      className={
                        className ? `${styles['markdown']} ${className}` : styles['markdown']
                      }
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
                  </LinkHandlerContext.Provider>
                </FrontmatterModeContext.Provider>
              </ImageRenderContext.Provider>
            </InlineCodeMarkdownLinkContext.Provider>
          </BaseUriContext.Provider>
        </AnchorScrollContext.Provider>
      </FileLinkContext.Provider>
    </MathOptionsContext.Provider>
  )
}

function readConfiguredMathMacros(
  config: IConfigurationService | undefined,
): Readonly<Record<string, string>> {
  // Partial IConfigurationService stubs exist in tests; treat them as "no
  // macros" rather than crashing every MarkdownView consumer.
  if (!config || typeof config.get !== 'function') return EMPTY_MATH_MACROS
  return sanitizeMathMacros(config.get<unknown>('markdown.math.macros'))
}

/**
 * `markdown.math.macros` is a global setting: resolve it here so every
 * MarkdownView consumer (preview, ACP chat, doc centre, release notes) renders
 * formulas with the same macros. A prop still wins for tests/embedders.
 */
function useMathMacros(
  override: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const config = useOptionalService(IConfigurationService)
  const [configured, setConfigured] = useState(() => readConfiguredMathMacros(config))
  useEffect(() => {
    if (!config || override !== undefined) return
    setConfigured(readConfiguredMathMacros(config))
    if (typeof config.onDidChangeConfiguration !== 'function') return
    const subscription = config.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('markdown.math.macros')) {
        setConfigured(readConfiguredMathMacros(config))
      }
    })
    return () => subscription?.dispose()
  }, [config, override])
  return override ?? configured
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
  schemesKey: string,
  mathEnabled: boolean,
): {
  readonly nodes: readonly MdNode[]
  readonly sealedNodes: readonly MdNode[]
  /** Characters still unsealed — the part every batch has to re-parse and re-render. */
  readonly tailChars: number
} {
  const parseOptions = useMemo<ParseMarkdownOptions | undefined>(() => {
    const schemes =
      schemesKey === '' ? [] : schemesKey.split(',').filter((scheme) => scheme.length > 0)
    if (!frontmatter && mathEnabled && schemes.length === 0) return undefined
    return {
      ...(frontmatter ? { frontmatter: true } : {}),
      ...(mathEnabled ? {} : { math: false }),
      ...(schemes.length > 0 ? { extraHrefSchemes: schemes } : {}),
    }
  }, [frontmatter, mathEnabled, schemesKey])
  // A sealed prefix is only reusable under the same parse options: switching
  // frontmatter/math/schemes after sealing would otherwise mix ASTs parsed with
  // different rules. Keying the cache on those options starts a fresh one.
  const optionKey = `${frontmatter ? '1' : '0'}:${mathEnabled ? '1' : '0'}:${schemesKey}`
  const cacheRef = useRef(createMarkdownStreamCache())
  const cacheKeyRef = useRef(optionKey)
  if (cacheKeyRef.current !== optionKey) {
    cacheKeyRef.current = optionKey
    cacheRef.current = createMarkdownStreamCache()
  }
  const cache = cacheRef.current
  const staticNodes = useMemo(
    () => (streaming ? undefined : parseMarkdown(text, parseOptions)),
    [text, streaming, parseOptions],
  )
  const parse = useMemo(() => (input: string) => parseMarkdown(input, parseOptions), [parseOptions])
  if (staticNodes !== undefined) {
    return {
      nodes: staticNodes,
      sealedNodes: cache.sealedNodes,
      tailChars: text.length - cache.sealedText.length,
    }
  }
  const nodes = parseMarkdownStreaming(text, cache, parse, mathEnabled)
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

/**
 * Consumer-owned link activation (release notes). While set, a non-http(s),
 * non-anchor href is the handler's alone: declining it does nothing rather than
 * falling through to the file/external branches.
 */
const LinkHandlerContext = createContext<MarkdownLinkHandler | undefined>(undefined)

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
 * `target` asks for the current tab (default), a right split, or a new window.
 */
export const DocLinkContext = createContext<
  ((href: string, opts?: { target?: OpenTarget }) => void) | undefined
>(undefined)

function Block({ node }: { node: MdNode }): ReactNode {
  const mathOptions = useContext(MathOptionsContext)
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
    case 'code_fence': {
      const lang = node.lang?.toLowerCase()
      if (lang === 'mermaid') return <MermaidBlock code={node.code} />
      if (lang === 'math' && mathOptions.enabled) {
        return (
          <MathBlockNode
            tex={node.code}
            {...(node.line !== undefined ? { line: node.line } : {})}
          />
        )
      }
      return <CodeFenceBlock node={node} />
    }
    case 'math_block':
      return (
        <MathBlockNode tex={node.tex} {...(node.line !== undefined ? { line: node.line } : {})} />
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
 * opener from context and turn bare paths inside the block into clickable links —
 * unless a link handler owns resolution, in which case the block stays inert.
 */
function CodeFenceBlock({ node }: { node: Extract<MdNode, { type: 'code_fence' }> }): ReactNode {
  const openFileLink = useContext(FileLinkContext)
  const handlerOwnsLinks = useContext(LinkHandlerContext) !== undefined
  return (
    <CodeBlock
      code={node.code}
      lang={node.lang}
      {...(handlerOwnsLinks ? {} : { onOpenFilePath: openFileLink })}
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
    case 'math_inline':
      return <MathInlineNode tex={node.tex} display={node.display} />
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
  // A host that owns link resolution (LinkHandlerContext) must not get file links
  // invented on its behalf — the release-notes viewer promises the only clickable
  // targets are doc:/command:/https/#anchor.
  const handlerOwnsLinks = useContext(LinkHandlerContext) !== undefined
  const link = renderMarkdownLink && !insideLink ? parseInlineCodeMarkdownLink(text) : undefined
  if (link) return <SafeLink href={link.href}>{renderInline(link.children)}</SafeLink>

  const match = matchFullFilePath(text)
  if (!match || insideLink || handlerOwnsLinks) {
    return <code className={styles['inlineCode']}>{text}</code>
  }
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    openFileLink(match.path, match.line, match.col, match.endLine, {
      target: resolveOpenTarget(e),
    })
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLAnchorElement>): void => {
    if (!isOpenTargetEnter(e)) return
    e.preventDefault()
    openFileLink(match.path, match.line, match.col, match.endLine, {
      target: resolveOpenTarget(e),
    })
  }
  return (
    <a
      href={text}
      onClick={onClick}
      onKeyDown={onKeyDown}
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
  const linkHandler = useContext(LinkHandlerContext)
  const isAnchor = isAnchorHref(href)
  // Case-insensitive: a bare `FILE:///…` autolink carries the scheme as typed.
  const isFile = /^file:/i.test(href)
  const isFilePath = !isFile && !isAnchor && looksLikeFilePath(href)
  // A relative doc link: starts with ./ or ../ and the path portion ends in .md
  const isRelativeDocLink =
    openDocLink !== undefined && /^\.\.?\//.test(href) && /\.md(#[^#]*)?$/.test(href)
  // http(s) is the one family that keeps its default handling when a handler
  // declines; everything else belongs to the handler (or to no one).
  const isExternalUrl = /^https?:/i.test(href)
  const handlerOwnsHref = linkHandler !== undefined && !isAnchor && !isExternalUrl
  const activate = (target: OpenTarget, openFolderInCurrentWindow: boolean): void => {
    if (isAnchor) {
      scrollToAnchor(href)
      return
    }
    if (linkHandler) {
      if (linkHandler(href, { target })) return
      if (handlerOwnsHref) return
    }
    // Doc-to-doc relative link: intercept before file-path resolution.
    if (isRelativeDocLink && openDocLink) {
      openDocLink(href, { target })
      return
    }
    if (isFilePath) {
      const { path, line, col, endLine, fragment } = splitFilePathTarget(href)
      openFileLink(path, line, col, endLine, {
        target,
        // Ctrl+Alt opens a directory target in the current window (preview only).
        openFolderInCurrentWindow,
        ...(fragment !== undefined ? { fragment } : {}),
      })
      return
    }
    if (isFile) {
      // Route through the same file-link pipeline as plain path links so a
      // directory target opens as a folder window and a markdown target can
      // open as a preview — not blindly into the editor resolver.
      const fileTarget = fileUriLinkTarget(href)
      if (fileTarget) {
        openFileLink(fileTarget.path, fileTarget.line, fileTarget.col, fileTarget.endLine, {
          target,
          openFolderInCurrentWindow,
          ...(fileTarget.fragment !== undefined ? { fragment: fileTarget.fragment } : {}),
        })
      }
      return
    }
    // External URL: let Electron's window-open handler take it. If unhandled,
    // the call is a no-op (better than navigating the renderer view).
    window.open(href, '_blank', 'noopener,noreferrer')
  }
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    activate(resolveOpenTarget(e), (e.ctrlKey || e.metaKey) && e.altKey)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLAnchorElement>): void => {
    if (!isOpenTargetEnter(e)) return
    e.preventDefault()
    activate(resolveOpenTarget(e), (e.ctrlKey || e.metaKey) && e.altKey)
  }
  return (
    <a
      href={href}
      onClick={onClick}
      onKeyDown={onKeyDown}
      target={
        isFile || isFilePath || isAnchor || isRelativeDocLink || handlerOwnsHref
          ? undefined
          : '_blank'
      }
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
  const handlerOwnsLinks = useContext(LinkHandlerContext) !== undefined
  const label =
    line !== undefined
      ? `${path}:${line}${col !== undefined ? `:${col}` : endLine !== undefined ? `-${endLine}` : ''}`
      : path
  // Inside another anchor the outer link already owns the click; a nested <a>
  // would be invalid HTML, so render as plain text. Same when a link handler owns
  // resolution: it decides what is clickable, not the renderer.
  if (insideLink || handlerOwnsLinks) return <Fragment>{label}</Fragment>
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    openFileLink(path, line, col, endLine, { target: resolveOpenTarget(e) })
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLAnchorElement>): void => {
    if (!isOpenTargetEnter(e)) return
    e.preventDefault()
    openFileLink(path, line, col, endLine, { target: resolveOpenTarget(e) })
  }
  return (
    <a
      href={label}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={styles['mdLink']}
      data-testid="md-filepath"
    >
      {label}
    </a>
  )
}
