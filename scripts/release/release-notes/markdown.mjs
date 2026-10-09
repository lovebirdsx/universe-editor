#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Markdown handling for release notes — markdown-it tokens only, never regexes.
 *
 *  One parse serves every consumer: the subset validator (fail-closed on constructs the
 *  app renderer or the site cannot render identically), the link auditor, the site HTML
 *  renderer, and the GitHub body serializer. `doc:`/`command:` links are rewritten once,
 *  on the token stream, so both targets describe the same thing — and never as a regex
 *  pass over the text (which would rewrite code blocks too).
 *--------------------------------------------------------------------------------------------*/

import MarkdownIt from 'markdown-it'
import { classifyHref, docUrlFor } from './source.mjs'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false })

// Accept every target at parse time so a forbidden link still becomes a link token —
// otherwise markdown-it would quietly demote `[x](file:///…)` to plain text and the
// audit below could never fail closed. Rendering never happens without that audit:
// parseNoteBody() couples parse, subset check and link audit into one call.
md.validateLink = () => true

// Validation-only twin. With `html: false` raw HTML degrades to plain text, so the
// subset check could never see it; this instance turns it into html_block/html_inline
// tokens that assertSupportedSubset rejects. Nothing renders from these tokens.
const mdHtmlProbe = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false })
mdHtmlProbe.validateLink = () => true

/**
 * Both instances must speak the same dialect, or the validation view and the rendered
 * view can disagree about what is a link.
 */
function configureDialect(instance) {
  // Explicit schemes only — same rule as the app renderer (markdownRenderer.ts BARE_URL_RE).
  // linkify's fuzzy mode turns `message.id`, `CLAUDE.md` or `install.sh` into links to real
  // domains, so the site and the GitHub body would linkify text the app shows as prose.
  instance.linkify.set({ fuzzyLink: false, fuzzyEmail: false })
  // Leave pure fragments alone: markdown-it percent-encodes them, but the site writes the
  // heading id verbatim, so `#子结构` must stay byte-identical to that id.
  const normalizeLink = instance.normalizeLink
  instance.normalizeLink = (url) => (url.startsWith('#') ? url : normalizeLink(url))
}

configureDialect(md)
configureDialect(mdHtmlProbe)

export function parseBody(body) {
  const env = {}
  const tokens = md.parse(body, env)
  return { tokens, env }
}

/** Token view that keeps raw HTML visible (validation only — never rendered). */
export function parseBodyForValidation(body) {
  const env = {}
  const tokens = mdHtmlProbe.parse(body, env)
  return { tokens, env }
}

/** Parse + validate. The only way to obtain renderable tokens for a note body. */
export function parseNoteBody(body, { label, docExists, lineOffset = 0 }) {
  const probe = parseBodyForValidation(body)
  assertSupportedSubset(probe.tokens, probe.env, { label, lineOffset })
  const { tokens, env } = parseBody(body)
  const slugs = assignHeadingAnchors(tokens)
  const warnings = assertLinksAllowed(tokens, {
    label,
    slugs,
    lineOffset,
    ...(docExists ? { docExists } : {}),
  })
  return { tokens, env, warnings }
}

/** Block-level tokens the app renderer (parseMarkdown AST) and the site both support. */
const ALLOWED_BLOCK_TOKENS = new Set([
  'paragraph_open',
  'paragraph_close',
  'inline',
  'heading_open',
  'heading_close',
  'bullet_list_open',
  'bullet_list_close',
  'ordered_list_open',
  'ordered_list_close',
  'list_item_open',
  'list_item_close',
  'blockquote_open',
  'blockquote_close',
  'fence',
  'table_open',
  'table_close',
  'thead_open',
  'thead_close',
  'tbody_open',
  'tbody_close',
  'tr_open',
  'tr_close',
  'th_open',
  'th_close',
  'td_open',
  'td_close',
  'hr',
])

const ALLOWED_INLINE_TOKENS = new Set([
  'text',
  'strong_open',
  'strong_close',
  'em_open',
  'em_close',
  's_open',
  's_close',
  'code_inline',
  'link_open',
  'link_close',
  'softbreak',
  'hardbreak',
])

const UNSUPPORTED_HINTS = {
  html_block: '原始 HTML',
  html_inline: '原始 HTML',
  image: '图片',
  footnote_ref: '脚注',
  code_block: '缩进式代码块（请用 ``` 包裹）',
}

function describeToken(token) {
  const hint = UNSUPPORTED_HINTS[token.type]
  if (hint) return hint
  return token.tag ? `${token.type} <${token.tag}>` : token.type
}

/** `lineOffset` lifts body-relative token lines into the enclosing file (archive sections). */
function tokenLine(token, lineOffset = 0) {
  return (token.map?.[0] ?? 0) + 1 + lineOffset
}

/**
 * Reject anything the two renderers cannot present identically (raw HTML, images,
 * reference-style links, …). Failing here is deliberate: silently dropping content
 * would ship a version page that differs from what the author wrote.
 */
export function assertSupportedSubset(tokens, env, { label, lineOffset = 0 }) {
  const references = env.references ? Object.keys(env.references) : []
  if (references.length > 0) {
    throw new Error(
      `${label}: 不支持引用式链接（${references.join(', ')}）；请写成 [文字](目标) 或 doc:/command: 形式`,
    )
  }
  for (const token of tokens) {
    if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        if (!ALLOWED_INLINE_TOKENS.has(child.type)) {
          throw new Error(
            `${label}:${tokenLine(token, lineOffset)}: 不支持的 Markdown 语法（${describeToken(child)}）`,
          )
        }
      }
      continue
    }
    if (token.type === 'heading_open') {
      // The app parser only knows ATX headings (`##`), and the version title is rendered
      // by the consumer — a setext heading (or an H1) would diverge between the two.
      if (!/^#+$/.test(token.markup)) {
        throw new Error(
          `${label}:${tokenLine(token, lineOffset)}: 标题不支持下划线式写法（请写成 ## 标题）`,
        )
      }
      if (token.tag === 'h1') {
        throw new Error(
          `${label}:${tokenLine(token, lineOffset)}: 正文不要写一级标题（版本标题由应用/站点渲染），请从 \`## \` 开始`,
        )
      }
    }
    if (!ALLOWED_BLOCK_TOKENS.has(token.type)) {
      throw new Error(
        `${label}:${tokenLine(token, lineOffset)}: 不支持的 Markdown 语法（${describeToken(token)}）`,
      )
    }
  }
}

/** Every explicit link target in the body, with its 1-based source line. */
export function collectLinks(tokens, lineOffset = 0) {
  const links = []
  for (const token of tokens) {
    if (token.type !== 'inline') continue
    for (const child of token.children ?? []) {
      if (child.type !== 'link_open') continue
      links.push({ href: child.attrGet('href') ?? '', line: tokenLine(token, lineOffset) })
    }
  }
  return links
}

/**
 * GitHub-style heading slug. Must stay identical to `slugifyHeading` in
 * apps/editor/src/renderer/services/acp/markdownRenderer.ts — the app scrolls to
 * `data-anchor="<slug>"`, the site writes `id="<slug>"`, and a divergence would make
 * `#anchor` work on one surface and dead-link on the other. Both sides assert the same
 * fixture table (shared/releaseNotes/__tests__/fixtures/headingSlugCases.json).
 */
export function slugifyHeading(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
}

/** Visible text of a heading's inline token, keeping inline code and dropping markers. */
function headingPlainText(inline) {
  let out = ''
  for (const child of inline?.children ?? []) {
    if (child.type === 'text' || child.type === 'code_inline') out += child.content
  }
  return out
}

/**
 * Give every heading the id the site needs for `#anchor` links, and report which slugs
 * exist (with multiplicity) so the link audit can fail a dangling or ambiguous anchor.
 * A heading whose slug is empty gets no id — the app renders it without a data-anchor too.
 */
export function assignHeadingAnchors(tokens) {
  const slugs = new Map()
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue
    const slug = slugifyHeading(headingPlainText(tokens[i + 1]))
    if (!slug) continue
    tokens[i].attrSet('id', slug)
    slugs.set(slug, (slugs.get(slug) ?? 0) + 1)
  }
  return slugs
}

/**
 * Link audit. `docExists` reports whether the doc ships with the running app; docs that
 * disappeared after the note was written are only a warning (the app falls back to the
 * version-pinned GitHub link), but a target the policy forbids is always fatal.
 * `slugs` (from assignHeadingAnchors) turns a dangling `#anchor` into a compile error
 * instead of a link that silently does nothing on every surface.
 */
export function assertLinksAllowed(tokens, { label, docExists, slugs, lineOffset = 0 }) {
  const warnings = []
  for (const { href, line } of collectLinks(tokens, lineOffset)) {
    const target = classifyHref(href)
    if (target.kind === 'invalid') {
      throw new Error(`${label}:${line}: 链接不可用 —— ${target.reason}（${href}）`)
    }
    if (target.kind === 'anchor' && slugs) {
      const count = slugs.get(target.anchor) ?? 0
      if (count === 0) {
        throw new Error(
          `${label}:${line}: 锚点 #${target.anchor} 在本稿内没有对应标题（请写标题 slug，如 #子结构italkitem）`,
        )
      }
      if (count > 1) {
        throw new Error(`${label}:${line}: 锚点 #${target.anchor} 命中多个标题，请让标题 slug 唯一`)
      }
    }
    if (target.kind === 'doc' && docExists && !docExists(target.docId)) {
      warnings.push(
        `${label}:${line}: 文档 ${target.docId} 不在当前安装包内，应用内将回退到 GitHub 链接`,
      )
    }
  }
  return warnings
}

function inlinePlainText(children) {
  let out = ''
  for (const child of children) {
    if (child.type === 'text' || child.type === 'code_inline') out += child.content
    else if (child.type === 'softbreak' || child.type === 'hardbreak') out += ' '
    else if (child.children) out += inlinePlainText(child.children)
    else if (child.type !== 'link_open' && child.type !== 'link_close') out += child.content
  }
  return out
}

/**
 * Rewrite link targets for the shipped consumers, in place on the token stream:
 * `doc:` becomes the version-pinned public URL, `command:` becomes readable text
 * (no browser-executable command link ever leaves the app). Anchor and http(s)
 * links only gain the new-tab attributes.
 */
export function prepareTokens(tokens, { version }) {
  for (const token of tokens) {
    if (token.type !== 'inline') continue
    const children = token.children ?? []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child.type !== 'link_open') continue
      const close = findLinkClose(children, i)
      const href = child.attrGet('href') ?? ''
      const target = classifyHref(href)
      if (target.kind === 'doc') {
        child.attrSet('href', docUrlFor(version, target.docId))
        child.attrSet('target', '_blank')
        child.attrSet('rel', 'noopener noreferrer')
      } else if (target.kind === 'command') {
        const label = inlinePlainText(children.slice(i + 1, close))
        child.type = 'text'
        child.content = `在编辑器中：${label}`
        child.attrs = null
        for (const inner of children.slice(i + 1, close)) {
          inner.type = 'text'
          inner.content = ''
          inner.children = null
        }
        children[close].type = 'text'
        children[close].content = ''
      } else if (target.kind === 'external') {
        child.attrSet('target', '_blank')
        child.attrSet('rel', 'noopener noreferrer')
      }
    }
  }
  return tokens
}

function findLinkClose(tokens, openIndex) {
  for (let i = openIndex + 1; i < tokens.length; i++) {
    if (tokens[i].type === 'link_close') return i
  }
  return tokens.length - 1
}

export function renderHtml(tokens) {
  return md.renderer.render(tokens, md.options, {})
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const MARKDOWN_ESCAPE = /[\\`*_[\]<>]/

function escapeMarkdownText(value) {
  let out = ''
  for (const ch of value) out += MARKDOWN_ESCAPE.test(ch) ? `\\${ch}` : ch
  return out
}

/**
 * Serialize tokens back to Markdown for the GitHub Release body. The subset is already
 * constrained by assertSupportedSubset; anything outside the serializer's vocabulary
 * throws instead of being dropped, so the body can never silently lose content.
 */
export function renderMarkdown(tokens) {
  const lines = renderBlocks(tokens, 0, tokens.length, { indent: 0, quote: 0 })
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  return `${text}\n`
}

function renderBlocks(tokens, start, end, ctx) {
  const out = []
  const emit = (line) => out.push(`${'> '.repeat(ctx.quote)}${' '.repeat(ctx.indent)}${line}`)
  const blank = () => out.push('')

  let i = start
  while (i < end) {
    const token = tokens[i]
    switch (token.type) {
      case 'paragraph_open': {
        const inline = tokens[i + 1]
        const lines = inlineMarkdown(inline?.children ?? []).split('\n')
        if (token.hidden) lines.forEach(emit)
        else {
          lines.forEach(emit)
          blank()
        }
        i += 3
        break
      }
      case 'heading_open': {
        const inline = tokens[i + 1]
        emit(`${'#'.repeat(Number(token.tag.slice(1)))} ${inlineMarkdown(inline?.children ?? [])}`)
        blank()
        i += 3
        break
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const close = matchingClose(tokens, i, token.type === 'ordered_list_open')
        out.push(...renderList(tokens, i, close, ctx, token))
        blank()
        i = close + 1
        break
      }
      case 'blockquote_open': {
        const close = matchingClose(tokens, i, false)
        out.push(...renderBlocks(tokens, i + 1, close, { ...ctx, quote: ctx.quote + 1 }))
        blank()
        i = close + 1
        break
      }
      case 'fence': {
        const lang = (token.info.trim().split(/\s+/)[0] ?? '').trim()
        emit(`\`\`\`${lang}`)
        for (const line of stripFinalNewline(token.content).split('\n')) emit(line)
        emit('```')
        blank()
        i += 1
        break
      }
      case 'code_block': {
        // Rejected by assertSupportedSubset — the app parser has no indented code.
        throw new Error('release notes 序列化未覆盖的语法：缩进式代码块（请用 ``` 包裹）')
      }
      case 'hr': {
        emit('---')
        blank()
        i += 1
        break
      }
      case 'table_open': {
        const close = matchingClose(tokens, i, false)
        out.push(...renderTable(tokens, i + 1, close, ctx))
        blank()
        i = close + 1
        break
      }
      case 'paragraph_close':
      case 'heading_close':
      case 'inline':
        i += 1
        break
      default:
        throw new Error(`release notes 序列化未覆盖的语法：${describeToken(token)}`)
    }
  }
  while (out.length > 0 && out.at(-1) === '') out.pop()
  return out
}

function renderList(tokens, openIndex, closeIndex, ctx, openToken) {
  const ordered = openToken.type === 'ordered_list_open'
  let index = Number(openToken.attrGet('start') ?? 1)
  const out = []
  let i = openIndex + 1
  while (i < closeIndex) {
    const token = tokens[i]
    if (token.type !== 'list_item_open') {
      i += 1
      continue
    }
    const close = matchingClose(tokens, i, false)
    const marker = ordered ? `${index++}. ` : '- '
    const body = renderBlocks(tokens, i + 1, close, { ...ctx, indent: ctx.indent + marker.length })
    const prefix = `${'> '.repeat(ctx.quote)}${' '.repeat(ctx.indent)}`
    body.forEach((line, n) => {
      if (line === '') {
        out.push('')
        return
      }
      // The first line trades the continuation indent for the list marker.
      const stripped = line.slice(prefix.length + marker.length)
      out.push(n === 0 ? `${prefix}${marker}${stripped}` : line)
    })
    i = close + 1
  }
  return out
}

function renderTable(tokens, start, end, ctx) {
  const out = []
  const emit = (line) => out.push(`${'> '.repeat(ctx.quote)}${' '.repeat(ctx.indent)}${line}`)
  let i = start
  let headerEmitted = false
  while (i < end) {
    const token = tokens[i]
    if (token.type !== 'th_open' && token.type !== 'td_open') {
      i += 1
      continue
    }
    const cells = []
    while (i < end && (tokens[i].type === 'th_open' || tokens[i].type === 'td_open')) {
      const inline = tokens[i + 1]
      cells.push(inlineMarkdown(inline?.children ?? []).replace(/\n/g, ' '))
      i += 3
    }
    emit(`| ${cells.join(' | ')} |`)
    if (!headerEmitted) {
      emit(`| ${cells.map(() => '---').join(' | ')} |`)
      headerEmitted = true
    }
  }
  return out
}

function matchingClose(tokens, openIndex, ordered) {
  const open = tokens[openIndex].type
  const closeType = open.replace('_open', '_close')
  let depth = 0
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokens[i].type === open) depth += 1
    else if (tokens[i].type === closeType) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error(`markdown token 结构不闭合：${open}${ordered ? ' (ordered)' : ''}`)
}

function stripFinalNewline(value) {
  return value.endsWith('\n') ? value.slice(0, -1) : value
}

function inlineMarkdown(children) {
  let out = ''
  const openLinks = []
  for (const child of children) {
    switch (child.type) {
      case 'text':
        out += escapeMarkdownText(child.content)
        break
      case 'code_inline':
        out += `\`${child.content}\``
        break
      case 'softbreak':
        out += '\n'
        break
      case 'hardbreak':
        out += '  \n'
        break
      case 'strong_open':
      case 'strong_close':
        out += '**'
        break
      case 'em_open':
      case 'em_close':
        out += '*'
        break
      case 's_open':
      case 's_close':
        out += '~~'
        break
      case 'link_open':
        openLinks.push(child.attrGet('href') ?? '')
        out += '['
        break
      case 'link_close':
        out += `](${openLinks.pop() ?? ''})`
        break
      default:
        throw new Error(`release notes 序列化未覆盖的行内语法：${describeToken(child)}`)
    }
  }
  return out
}

export { md as markdownIt }
