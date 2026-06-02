/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MessageContent — render a sequence of ACP content blocks as React elements.
 *  Text blocks go through the markdown parser; image blocks become inline
 *  images (data: URI is safe — the agent never gets to embed a remote URL);
 *  resource / resource_link blocks become file-open buttons when the URI is a
 *  workspace file, or visible labels otherwise.
 *
 *  Slash-command artifacts: agents (notably Claude Code) replay locally-handled
 *  slash commands back through `user_message_chunk` as XML-wrapped text. We
 *  group consecutive text blocks into runs, parse out `<command-name>` etc.
 *  wrappers with `parseCommandWrappers`, and render them as compact badges
 *  instead of leaking raw XML into the markdown pipeline. Grouping at the
 *  *message* level (not per-block) is deliberate: streaming can split an open
 *  tag and its close tag across separate text blocks.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { IEditorResolverService, URI } from '@universe-editor/platform'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { parseCommandWrappers } from '../../services/acp/commandWrapper.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import { useService } from '../useService.js'
import { CommandInvocationBadge } from './CommandInvocationBadge.js'
import styles from './agents.module.css'

interface MessageContentProps {
  readonly blocks: readonly ContentBlock[]
}

type NonTextBlock = Exclude<ContentBlock, { type: 'text' }>
type BlockGroup =
  | { readonly type: 'text-run'; readonly text: string }
  | { readonly type: 'other'; readonly block: NonTextBlock }

function groupBlocks(blocks: readonly ContentBlock[]): readonly BlockGroup[] {
  const groups: BlockGroup[] = []
  let buffer = ''
  for (const b of blocks) {
    if (b.type === 'text') {
      buffer += b.text
    } else {
      if (buffer.length > 0) {
        groups.push({ type: 'text-run', text: buffer })
        buffer = ''
      }
      groups.push({ type: 'other', block: b })
    }
  }
  if (buffer.length > 0) groups.push({ type: 'text-run', text: buffer })
  return groups
}

export function MessageContent({ blocks }: MessageContentProps) {
  const groups = useMemo(() => groupBlocks(blocks), [blocks])
  return (
    <div className={styles['messageBody']}>
      {groups.map((g, i) =>
        g.type === 'text-run' ? (
          <TextRunSegments key={i} text={g.text} />
        ) : (
          <BlockNode key={i} block={g.block} />
        ),
      )}
    </div>
  )
}

function TextRunSegments({ text }: { text: string }) {
  const segments = useMemo(() => parseCommandWrappers(text), [text])
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'command' ? (
          <CommandInvocationBadge key={i} invocation={seg.invocation} />
        ) : (
          <MarkdownBlock key={i} text={seg.text} />
        ),
      )}
    </>
  )
}

function BlockNode({ block }: { block: NonTextBlock }) {
  switch (block.type) {
    case 'image':
      return <ImageBlock mimeType={block.mimeType} data={block.data} />
    case 'audio':
      return (
        <div className={styles['audioBlock']} data-testid="acp-audio-block">
          [audio: {block.mimeType}]
        </div>
      )
    case 'resource':
      return <ResourceLink uri={block.resource.uri} />
    case 'resource_link':
      return (
        <ResourceLink
          uri={block.uri}
          {...(block.name != null ? { name: block.name } : {})}
          {...(block.description != null ? { description: block.description } : {})}
          {...(block.mimeType != null ? { mimeType: block.mimeType } : {})}
        />
      )
  }
}

// ---------------------------------------------------------------------------
// Markdown text → React (shared renderer)
// ---------------------------------------------------------------------------

function MarkdownBlock({ text }: { text: string }) {
  return <MarkdownView text={text} testId="acp-markdown" />
}

// ---------------------------------------------------------------------------
// Resource rendering
// ---------------------------------------------------------------------------

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
