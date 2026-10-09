#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Static pages for the download site: one page per version, plus the history index.
 *  Self-contained (inline styles, no scripts, no external assets), readable on phones,
 *  light and dark. Everything interpolated here is escaped; the body HTML comes from
 *  markdown-it with `html: false` and a link policy that rejects everything undeclared.
 *--------------------------------------------------------------------------------------------*/

import { escapeHtml } from './markdown.mjs'
import { versionHeading } from './source.mjs'

const PAGE_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --card: #ffffff;
  --fg: #1c1f26;
  --muted: #5c6472;
  --accent: #2563eb;
  --border: #e2e5ea;
  --code-bg: #f0f2f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --card: #171a21;
    --fg: #e7e9ee;
    --muted: #9aa3b2;
    --accent: #6ea1ff;
    --border: #262b36;
    --code-bg: #1f232c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px 16px 64px;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif;
  font-size: 15px;
  line-height: 1.7;
  background: var(--bg);
  color: var(--fg);
}
main { max-width: 760px; margin: 0 auto; }
a { color: var(--accent); }
.back { display: inline-block; margin-bottom: 16px; font-size: 14px; text-decoration: none; }
header { margin-bottom: 24px; }
h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.35; }
.meta, .summary { margin: 0; color: var(--muted); font-size: 14px; }
.summary { margin-top: 6px; }
article h2 { margin: 28px 0 10px; font-size: 18px; }
article h3 { margin: 22px 0 8px; font-size: 16px; }
article ul, article ol { margin: 8px 0; padding-left: 22px; }
article li { margin: 4px 0; }
article blockquote {
  margin: 12px 0;
  padding: 4px 14px;
  border-left: 3px solid var(--border);
  color: var(--muted);
}
article code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--code-bg);
  font-size: 13px;
}
article pre {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--code-bg);
  overflow: auto;
}
article pre code { padding: 0; background: none; }
article table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
article th, article td { padding: 6px 10px; border: 1px solid var(--border); text-align: left; }
article hr { margin: 24px 0; border: 0; border-top: 1px solid var(--border); }
article img { max-width: 100%; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { padding: 14px 0; border-top: 1px solid var(--border); }
.list .v { font-weight: 600; }
.list .d { color: var(--muted); font-size: 13px; margin-left: 8px; }
.list .s { display: block; margin-top: 4px; color: var(--muted); font-size: 14px; }
.list a { text-decoration: none; }
.list a:hover .v, .list a:focus-visible .v { text-decoration: underline; }
.empty { color: var(--muted); }
`.trim()

function shell({ title, description, body, backHref, backLabel }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <style>
${PAGE_CSS}
    </style>
  </head>
  <body>
    <main>
      <a class="back" href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a>
${body}
    </main>
  </body>
</html>
`
}

/** One version page: header from the note metadata, body from the compiled markdown. */
export function renderNotePage({
  note,
  bodyHtml,
  indexHref = './index.html',
  homeHref = '../index.html',
}) {
  const heading = versionHeading(note)
  const title = note.title ? `${heading} — ${note.title}` : heading
  const summary = note.summary ? `\n      <p class="summary">${escapeHtml(note.summary)}</p>` : ''
  const article =
    bodyHtml.trim() === ''
      ? '        <p class="empty">此版本没有记录用户可见的变更。</p>'
      : bodyHtml.trimEnd()
  return shell({
    title: `Universe Editor ${title}`,
    description: note.summary || `Universe Editor ${heading} 版本介绍`,
    backHref: homeHref,
    backLabel: '← 返回下载页',
    body: `      <header>
        <h1>Universe Editor ${escapeHtml(heading)}</h1>${
          note.title ? `\n        <p class="meta">${escapeHtml(note.title)}</p>` : ''
        }${summary}
        <p class="meta"><a href="${escapeHtml(indexHref)}">全部版本 →</a></p>
      </header>
      <article>
${article}
      </article>`,
  })
}

/** History index — plain links, no JavaScript, newest first. */
export function renderIndexPage({ notes, homeHref = '../index.html' }) {
  const items = notes
    .map((note) => {
      const label = note.title ? ` — ${escapeHtml(note.title)}` : ''
      const summary = note.summary
        ? `\n          <span class="s">${escapeHtml(note.summary)}</span>`
        : ''
      const date = note.date ? `<span class="d">${escapeHtml(note.date)}</span>` : ''
      return `        <li>
          <a href="./v${escapeHtml(note.version)}.html">
            <span class="v">Universe Editor v${escapeHtml(note.version)}</span>${label}${date}
          </a>${summary}
        </li>`
    })
    .join('\n')
  const list =
    notes.length > 0
      ? `      <ul class="list">\n${items}\n      </ul>`
      : '      <p class="empty">暂无版本介绍。</p>'
  return shell({
    title: 'Universe Editor — 全部版本介绍',
    description: 'Universe Editor 各版本更新说明',
    backHref: homeHref,
    backLabel: '← 返回下载页',
    body: `      <header>\n        <h1>全部版本介绍</h1>\n      </header>\n${list}`,
  })
}
