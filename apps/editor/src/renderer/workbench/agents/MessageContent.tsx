/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MessageContent — render a sequence of ACP content blocks as React elements.
 *  Text blocks go through the markdown parser; image blocks become inline
 *  images (data: URI is safe — the agent never gets to embed a remote URL);
 *  resource / resource_link blocks become file-open buttons when the URI is a
 *  workspace file, or visible labels otherwise.
 *--------------------------------------------------------------------------------------------*/

import { Fragment, useMemo, type ReactNode } from 'react'
import { IEditorResolverService, URI } from '@universe-editor/platform'
import type { AcpContentBlock } from '../../services/acp/acpProtocol.js'
import { parseMarkdown, type MdInline, type MdNode } from '../../services/acp/markdownRenderer.js'
import { useService } from '../useService.js'
import { CodeBlock } from './CodeBlock.js'
import styles from './agents.module.css'

interface MessageContentProps {
  readonly blocks: readonly AcpContentBlock[]
}

export function MessageContent({ blocks }: MessageContentProps) {
  return (
    <div className={styles['messageBody']}>
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} />
      ))}
    </div>
  )
}

function BlockNode({ block }: { block: AcpContentBlock }) {
  switch (block.type) {
    case 'text':
      return <MarkdownBlock text={block.text} />
    case 'image':
      return <ImageBlock mimeType={block.mimeType} data={block.data} />
    case 'audio':
      return (
        <div className={styles['audioBlock']} data-testid="acp-audio-block">
          [audio: {block.mimeType}]
        </div>
      )
    case 'resource':
      return <ResourceLink uri={block.uri} />
    case 'resource_link':
      return (
        <ResourceLink
          uri={block.uri}
          {...(block.name !== undefined ? { name: block.name } : {})}
          {...(block.description !== undefined ? { description: block.description } : {})}
          {...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {})}
        />
      )
  }
}

// ---------------------------------------------------------------------------
// Markdown text → React
// ---------------------------------------------------------------------------

function MarkdownBlock({ text }: { text: string }) {
  const nodes = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className={styles['markdown']} data-testid="acp-markdown">
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
    case 'hr':
      return <hr />
  }
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

// ---------------------------------------------------------------------------
// Link / resource rendering
// ---------------------------------------------------------------------------

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

function ResourceLink({
  uri,
  name,
  description,
  mimeType,
}: {
  readonly uri: string
  readonly name?: string
  readonly description?: string
  readonly mimeType?: string
}) {
  const editorResolver = useService(IEditorResolverService)
  const isFile = uri.startsWith('file:')
  const label = name ?? uri
  const onClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    if (!isFile) return
    try {
      const parsed = URI.parse(uri)
      void editorResolver.openEditor(parsed)
    } catch {
      // ignored — defensive against malformed agent output
    }
  }
  return (
    <button
      type="button"
      className={styles['resourceLink']}
      onClick={onClick}
      disabled={!isFile}
      title={description ?? uri}
      data-testid="acp-resource-link"
    >
      <span className={styles['resourceIcon']} aria-hidden>
        📄
      </span>
      <span className={styles['resourceName']}>{label}</span>
      {mimeType && <span className={styles['resourceMime']}>{mimeType}</span>}
    </button>
  )
}

function ImageBlock({ mimeType, data }: { readonly mimeType: string; readonly data: string }) {
  const src = `data:${mimeType};base64,${data}`
  return (
    <img
      src={src}
      alt=""
      className={styles['imageBlock']}
      data-testid="acp-image-block"
      data-mime={mimeType}
    />
  )
}
