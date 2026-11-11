import {
  looksLikeFilePath,
  parseMarkdown,
  type MdInline,
  type MdListItem,
  type MdNode,
  type TableAlign,
} from '@universe-editor/acp-view-model'
import { Fragment, createContext, useContext, useMemo, type ReactNode } from 'react'
import { strings } from '../strings.js'
import { MarkdownImage, type MarkdownImageLoader } from './MarkdownImage.js'
import { resolveMarkdownImageSource } from './imageSource.js'

export interface MarkdownViewProps {
  readonly text: string
  readonly testId?: string
  /**
   * When present, workspace/file images render as clickable previews. Without
   * it the renderer keeps the text placeholder (other markdown surfaces do not
   * have a gateway to resolve PC paths).
   */
  readonly imageLoader?: MarkdownImageLoader | undefined
}

const ImageLoaderContext = createContext<MarkdownImageLoader | undefined>(undefined)

/**
 * Phone-sized React renderer for the shared markdown AST. No raw HTML is ever
 * emitted: text nodes are React children (escaped), only http(s) links are
 * anchors, and file paths stay visible but inert because the phone cannot open
 * files.
 */
export function MarkdownView({ text, testId, imageLoader }: MarkdownViewProps) {
  const nodes = useMemo(() => parseMarkdown(text), [text])
  return (
    <ImageLoaderContext.Provider value={imageLoader}>
      <div className="md" {...(testId !== undefined ? { 'data-testid': testId } : {})}>
        {nodes.map((node, index) => (
          <MarkdownBlock key={index} node={node} />
        ))}
      </div>
    </ImageLoaderContext.Provider>
  )
}

function MarkdownBlock({ node }: { node: MdNode }): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p>{renderInline(node.children)}</p>
    case 'heading': {
      const Tag = `h${node.level}` as const
      return (
        <Tag className={`md-heading md-heading--${node.level}`}>{renderInline(node.children)}</Tag>
      )
    }
    case 'code_fence':
      return (
        <div className="md-code-block">
          {node.lang !== '' && <div className="md-code-block__lang">{node.lang}</div>}
          <pre className="md-pre">
            <code>{node.code}</code>
          </pre>
        </div>
      )
    case 'list': {
      const items = node.items.map((item, index) => <ListItem key={index} item={item} />)
      if (node.ordered) {
        return <ol start={node.start ?? 1}>{items}</ol>
      }
      return <ul>{items}</ul>
    }
    case 'blockquote':
      return (
        <blockquote>
          {node.children.map((child, index) => (
            <MarkdownBlock key={index} node={child} />
          ))}
        </blockquote>
      )
    case 'frontmatter':
      return (
        <table className="md-frontmatter">
          <tbody>
            {node.entries.map(([key, value], index) => (
              <tr key={index}>
                <th scope="row">{key}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'table':
      return (
        <div className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {node.header.map((cell, index) => (
                  <th key={index} style={alignStyle(node.align[index])}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={alignStyle(node.align[cellIndex])}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'hr':
      return <hr />
    case 'math_block':
      return (
        <pre className="md-pre md-math-block">
          <code>{node.tex}</code>
        </pre>
      )
  }
}

function ListItem({ item }: { item: MdListItem }): ReactNode {
  return (
    <li>
      {item.checked !== null && (
        <input type="checkbox" checked={item.checked} readOnly disabled className="md-checkbox" />
      )}
      {renderInline(item.inline)}
      {item.children?.map((child, index) => (
        <MarkdownBlock key={index} node={child} />
      ))}
    </li>
  )
}

function renderInline(nodes: readonly MdInline[]): ReactNode {
  return nodes.map((node, index) => <InlineNode key={index} node={node} />)
}

function InlineNode({ node }: { node: MdInline }): ReactNode {
  const loader = useContext(ImageLoaderContext)
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
      return <code className="md-inline-code">{node.text}</code>
    case 'link':
      if (containsImage(node.children)) {
        // A markdown link around an image would nest a preview <button> inside
        // an <a>; keep the label inert instead of guessing at two actions.
        return <span className="md-link md-link--inert">{renderInline(node.children)}</span>
      }
      return <MarkdownLink href={node.href}>{renderInline(node.children)}</MarkdownLink>
    case 'filepath': {
      const label =
        node.line !== undefined
          ? `${node.path}:${node.line}${node.col !== undefined ? `:${node.col}` : node.endLine !== undefined ? `-${node.endLine}` : ''}`
          : node.path
      return <span className="md-filepath">{label}</span>
    }
    case 'image': {
      const source = resolveMarkdownImageSource(node.src)
      // Without a gateway-backed loader keep the inert placeholder; markdown
      // surfaces outside the chat must never start loading phone-visible images.
      if (loader === undefined || source === undefined) {
        return (
          <span className="md-image-placeholder">
            {strings.markdownImage(node.alt === '' ? undefined : node.alt)}
          </span>
        )
      }
      return <MarkdownImage source={source} alt={node.alt} loader={loader} />
    }
    case 'anchor':
      return <span id={node.id} className="md-anchor" />
    case 'math_inline':
      return <code className="md-math-inline">{node.tex}</code>
    case 'softbreak':
      return <br />
  }
}

function containsImage(nodes: readonly MdInline[]): boolean {
  for (const node of nodes) {
    switch (node.type) {
      case 'image':
        return true
      case 'bold':
      case 'italic':
      case 'strike':
      case 'link':
        if (containsImage(node.children)) return true
        break
    }
  }
  return false
}

function MarkdownLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  if (href.startsWith('#')) return <span className="md-link md-link--inert">{children}</span>
  if (href.startsWith('file:') || looksLikeFilePath(href)) {
    return <span className="md-filepath">{children}</span>
  }
  if (!/^https?:/i.test(href)) {
    return <span className="md-link md-link--inert">{children}</span>
  }
  return (
    <a className="md-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function alignStyle(align: TableAlign | null | undefined): React.CSSProperties | undefined {
  return align ? { textAlign: align } : undefined
}
