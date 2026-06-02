/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownView — render a markdown string as React elements via the shared
 *  `parseMarkdown` AST. No raw HTML is emitted from user text (React escapes
 *  text nodes); only Monaco-colorized code (trusted, escaped) uses innerHTML,
 *  inside CodeBlock. Font size / colour are inherited from the container so the
 *  same component fits both the compact ACP chat and the roomier doc preview.
 *--------------------------------------------------------------------------------------------*/

import { Fragment, useMemo, type ReactNode } from 'react'
import { IEditorResolverService, URI } from '@universe-editor/platform'
import {
  parseMarkdown,
  type MdInline,
  type MdNode,
  type TableAlign,
} from '../../services/acp/markdownRenderer.js'
import { CodeBlock } from '../agents/CodeBlock.js'
import { useService } from '../useService.js'
import styles from './markdown.module.css'

interface MarkdownViewProps {
  readonly text: string
  readonly className?: string
  readonly testId?: string
}

export function MarkdownView({ text, className, testId }: MarkdownViewProps) {
  const nodes = useMemo(() => parseMarkdown(text), [text])
  return (
    <div
      className={className ? `${styles['markdown']} ${className}` : styles['markdown']}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
    >
      {nodes.map((node, i) => (
        <Block key={i} node={node} />
      ))}
    </div>
  )
}

function Block({ node }: { node: MdNode }): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p>{renderInline(node.children)}</p>
    case 'heading': {
      const Tag = `h${node.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return <Tag>{renderInline(node.children)}</Tag>
    }
    case 'code_fence':
      return <CodeBlock code={node.code} lang={node.lang} />
    case 'list':
      return node.ordered ? (
        <ol>
          {node.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul>
          {node.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      )
    case 'blockquote':
      return <blockquote>{renderInline(node.children)}</blockquote>
    case 'table':
      return (
        <table>
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
      return <hr />
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
    case 'code':
      return <code className={styles['inlineCode']}>{node.text}</code>
    case 'softbreak':
      return <Fragment>{'\n'}</Fragment>
    case 'link':
      return <SafeLink href={node.href}>{renderInline(node.children)}</SafeLink>
  }
}

function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  const editorResolver = useService(IEditorResolverService)
  const isFile = href.startsWith('file:')
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
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
      target={isFile ? undefined : '_blank'}
      rel="noopener noreferrer"
      className={styles['mdLink']}
    >
      {children}
    </a>
  )
}
