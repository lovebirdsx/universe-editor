/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MessageContent — render a sequence of ACP content blocks as React elements.
 *  Text blocks go through the markdown parser by default; user messages pass
 *  variant="plain" instead (matching mainstream agents: a user's prompt renders
 *  verbatim — newlines kept, no `**`/`#` interpretation — with bare URLs, bare
 *  file paths and markdown links turned into clickable links), while assistant
 *  output keeps full markdown. Agents replay `@file` mentions as markdown links
 *  (`[@a.md](file:///…)`), so those must stay clickable in a prompt too. Image
 *  blocks become inline images (data: URI is safe — the agent never gets to
 *  embed a remote URL); resource / resource_link blocks become file-open buttons
 *  when the URI is a workspace file, or visible labels otherwise.
 *
 *  Slash-command artifacts: agents (notably Claude Code) replay locally-handled
 *  slash commands back through `user_message_chunk` as XML-wrapped text. We
 *  group consecutive text blocks into runs, parse out `<command-name>` etc.
 *  wrappers with `parseCommandWrappers`, and render them as compact badges
 *  instead of leaking raw XML into the markdown pipeline. Grouping at the
 *  *message* level (not per-block) is deliberate: streaming can split an open
 *  tag and its close tag across separate text blocks.
 *--------------------------------------------------------------------------------------------*/

import { memo, useContext, useMemo, type ReactNode } from 'react'
import { IEditorResolverService, IWorkspaceService, URI } from '@universe-editor/platform'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { parseCommandWrappers } from '../../services/acp/commandWrapper.js'
import {
  looksLikeFilePath,
  matchFilePathAt,
  splitFilePathTarget,
  type FilePathTarget,
} from '../../services/acp/filePathLink.js'
import {
  isAnchorHref,
  matchBareUrl,
  matchMarkdownLinkAt,
} from '../../services/acp/markdownRenderer.js'
import { FileLinkContext, MarkdownView } from '../markdown/MarkdownView.js'
import { fileUriLinkTarget } from '../markdown/markdownLinkResolve.js'
import { useMarkdownFileLink } from '../markdown/useMarkdownFileLink.js'
import { useOptionalService, useService } from '../useService.js'
import { CommandInvocationBadge } from './CommandInvocationBadge.js'
import { ChatImage } from './ChatImage.js'
import styles from './agents.module.css'

interface MessageContentProps {
  readonly blocks: readonly ContentBlock[]
  /**
   * True while this message is still streaming. Routes the markdown text through
   * the incremental parser so a long live message doesn't re-parse its whole
   * accumulated text on every chunk. Off for settled messages and tool output.
   */
  readonly streaming?: boolean
  /**
   * 'markdown' (default) renders text blocks through the markdown parser;
   * 'plain' renders them verbatim with `white-space: pre-wrap` (user messages —
   * the prompt should look exactly like what was typed), with one exception:
   * bare URLs, bare file paths and markdown links become clickable links, and a
   * link's label replaces its `[label](href)` syntax. Non-text blocks and
   * slash-command badges render identically under both variants.
   */
  readonly variant?: 'markdown' | 'plain'
}

type NonTextBlock = Exclude<ContentBlock, { type: 'text' }>
type ImageContentBlock = Extract<ContentBlock, { type: 'image' }>
type BlockGroup =
  | { readonly type: 'text-run'; readonly text: string }
  | { readonly type: 'image-row'; readonly images: readonly ImageContentBlock[] }
  | { readonly type: 'other'; readonly block: NonTextBlock }

// Consecutive image blocks are merged into one row group so multiple attached
// pictures lay out horizontally (wrapping) instead of stacking vertically.
function groupBlocks(blocks: readonly ContentBlock[]): readonly BlockGroup[] {
  const groups: BlockGroup[] = []
  let buffer = ''
  let images: ImageContentBlock[] = []
  const flushText = (): void => {
    if (buffer.length > 0) {
      groups.push({ type: 'text-run', text: buffer })
      buffer = ''
    }
  }
  const flushImages = (): void => {
    if (images.length > 0) {
      groups.push({ type: 'image-row', images })
      images = []
    }
  }
  for (const b of blocks) {
    if (b.type === 'text') {
      flushImages()
      buffer += b.text
    } else if (b.type === 'image') {
      flushText()
      images.push(b)
    } else {
      flushText()
      flushImages()
      groups.push({ type: 'other', block: b })
    }
  }
  flushText()
  flushImages()
  return groups
}

export const MessageContent = memo(function MessageContent({
  blocks,
  streaming,
  variant,
}: MessageContentProps) {
  const groups = useMemo(() => groupBlocks(blocks), [blocks])
  return (
    <div className={styles['messageBody']}>
      {groups.map((g, i) =>
        g.type === 'text-run' ? (
          <TextRunSegments
            key={i}
            text={g.text}
            streaming={streaming ?? false}
            plain={variant === 'plain'}
          />
        ) : g.type === 'image-row' ? (
          <ImageRow key={i} images={g.images} />
        ) : (
          <BlockNode key={i} block={g.block} />
        ),
      )}
    </div>
  )
})

function TextRunSegments({
  text,
  streaming,
  plain,
}: {
  text: string
  streaming: boolean
  plain: boolean
}) {
  const segments = useMemo(() => parseCommandWrappers(text), [text])
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'command' ? (
          <CommandInvocationBadge key={i} invocation={seg.invocation} />
        ) : plain ? (
          <PlainTextBlock key={i} text={seg.text} />
        ) : (
          <MarkdownBlock key={i} text={seg.text} streaming={streaming} />
        ),
      )}
    </>
  )
}

// User-prompt text under variant="plain": verbatim, whitespace-preserving, and
// safe for long unbroken strings (URLs/paths) inside the clamped user card.
// Bare URLs, bare file paths, and markdown links `[label](href)` become
// clickable — the sameness is structural, they are the markdown renderer's own
// matchers. Everything else (headings, emphasis, inline code, images, anchors)
// stays literal.
function PlainTextBlock({ text }: { text: string }) {
  const workspaceService = useOptionalService(IWorkspaceService)
  // The same openFileLink pipeline markdown links use (FilePathLink in
  // MarkdownView): existing paths open instantly, a directory opens as a folder
  // window, several fuzzy hits hand off to Go to File, none → notification.
  const openFileLink = useMarkdownFileLink(workspaceService?.current?.folder, false)
  const segments = useMemo(() => linkifyPlainText(text), [text])
  return (
    <div className={styles['plainTextBlock']} data-testid="acp-plaintext">
      <FileLinkContext.Provider value={openFileLink}>
        {segments.map((seg, i) =>
          seg.type === 'link' ? (
            <PlainLink key={i} seg={seg} />
          ) : seg.type === 'filepath' ? (
            <PlainFilePathLink key={i} seg={seg} />
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </FileLinkContext.Provider>
    </div>
  )
}

/** Where a plain-text link points: a file to open, or nowhere (external URL). */
function plainLinkTarget(href: string): FilePathTarget | undefined {
  if (/^file:/i.test(href)) return fileUriLinkTarget(href)
  if (looksLikeFilePath(href)) return splitFilePathTarget(href)
  return undefined
}

// Attributes for an external link only: a file target is opened in place, so it
// must NOT carry target=_blank — the window-open handler would push it to the OS
// instead of the workbench.
const EXTERNAL_LINK_ATTRS = { target: '_blank', rel: 'noopener noreferrer' } as const

// Mirrors SafeLink's routing (MarkdownView) minus the surfaces the plain variant
// has no context for: no preview/doc-link interception, and an anchor can't be
// scrolled here — those are kept literal by linkifyPlainText.
function PlainLink({ seg }: { seg: PlainLinkSegment }) {
  const openFileLink = useContext(FileLinkContext)
  const label = seg.text
  const target = plainLinkTarget(seg.href)
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    if (!target) {
      // Same external-URL exit as SafeLink: Electron's window-open handler
      // routes http(s) to shell.openExternal and denies everything else.
      window.open(seg.href, '_blank', 'noopener,noreferrer')
      return
    }
    openFileLink(target.path, target.line, target.col, target.endLine, {
      toSide: e.ctrlKey || e.metaKey,
      ...(target.fragment !== undefined ? { fragment: target.fragment } : {}),
    })
  }
  return (
    <a href={seg.href} onClick={onClick} {...(target ? {} : EXTERNAL_LINK_ATTRS)}>
      {label}
    </a>
  )
}

function PlainFilePathLink({ seg }: { seg: PlainFilePathSegment }) {
  const openFileLink = useContext(FileLinkContext)
  const label = seg.text
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    openFileLink(seg.path, seg.line, seg.col, seg.endLine, {
      toSide: e.ctrlKey || e.metaKey,
    })
  }
  return (
    <a href={label} onClick={onClick} data-testid="md-filepath">
      {label}
    </a>
  )
}

type PlainFilePathSegment = {
  readonly type: 'filepath'
  /** Full matched text including any `:line:col` suffix — what the user sees. */
  readonly text: string
  readonly path: string
  readonly line?: number
  readonly col?: number
  readonly endLine?: number
}
type PlainLinkSegment = {
  readonly type: 'link'
  /** Visible text: the markdown link's label, or the URL itself when bare. */
  readonly text: string
  readonly href: string
}
type PlainSegment =
  | { readonly type: 'text'; readonly text: string }
  | PlainLinkSegment
  | PlainFilePathSegment

// Left-to-right scan reusing the markdown renderer's own matchers, in the same
// order as parseInline (link syntax → bare URL → bare path), so both renderers
// agree on what counts as a link — CJK termination, trailing punctuation,
// mid-word guards, and the `/`-prefix guard that keeps a URL's path tail out.
function linkifyPlainText(text: string): readonly PlainSegment[] {
  const out: PlainSegment[] = []
  let buf = ''
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ type: 'text', text: buf })
      buf = ''
    }
  }
  let i = 0
  while (i < text.length) {
    const link = matchMarkdownLinkAt(text, i)
    if (link) {
      if (link.image || isAnchorHref(link.href)) {
        // Nothing to open here (images aren't rendered in a prompt, and an
        // anchor needs a document to scroll). Consume the whole match so its
        // parts can't be re-matched as a bare path — that also keeps a multi-KB
        // `data:` URL off the per-character probe.
        buf += text.slice(i, link.end)
      } else {
        flush()
        out.push({ type: 'link', text: link.label, href: link.href })
      }
      i = link.end
      continue
    }
    const url = matchBareUrl(text, i)
    if (url) {
      flush()
      out.push({ type: 'link', text: url, href: url })
      i += url.length
      continue
    }
    const fp = matchFilePathAt(text, i)
    if (fp) {
      flush()
      out.push({
        type: 'filepath',
        text: fp.full,
        path: fp.path,
        ...(fp.line !== undefined ? { line: fp.line } : {}),
        ...(fp.col !== undefined ? { col: fp.col } : {}),
        ...(fp.endLine !== undefined ? { endLine: fp.endLine } : {}),
      })
      i += fp.full.length
      continue
    }
    buf += text[i]!
    i++
  }
  flush()
  return out
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

function MarkdownBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const workspaceService = useOptionalService(IWorkspaceService)
  const baseUri = workspaceService?.current?.folder
  return (
    <MarkdownView
      text={text}
      testId="acp-markdown"
      streaming={streaming}
      renderImage={renderChatImage}
      {...(baseUri ? { baseUri } : {})}
    />
  )
}

// An image an agent embedded in markdown text (e.g. a base64 `data:` image on
// session restore) renders as the same thumbnail-with-preview control used for
// ACP image content blocks.
function renderChatImage(src: string, alt: string): ReactNode {
  return <ChatImage src={src} alt={alt} testId="acp-image-block" />
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
      data-tooltip={description ?? uri}
      data-uri={uri}
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
  return <ChatImage src={src} alt="" testId="acp-image-block" mimeType={mimeType} />
}

function ImageRow({ images }: { readonly images: readonly ImageContentBlock[] }) {
  return (
    <div className={styles['chatImageRow']} data-testid="acp-image-row">
      {images.map((img, i) => (
        <ImageBlock key={i} mimeType={img.mimeType} data={img.data} />
      ))}
    </div>
  )
}
