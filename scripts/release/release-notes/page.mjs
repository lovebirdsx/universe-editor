#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Static pages for the download site: one page per version, plus the history index.
 *  Self-contained (inline styles, no scripts, no external assets), readable on phones,
 *  dark like the download page. Everything interpolated here is escaped; the body HTML
 *  comes from markdown-it with `html: false` and a link policy that rejects everything
 *  undeclared.
 *--------------------------------------------------------------------------------------------*/

import { escapeHtml } from './markdown.mjs'
import { versionHeading } from './source.mjs'

// Same dark tokens as the download page / gallery pages (server/pageStyles.mjs):
// a note page is reached from the download card, so it must not change design
// language mid-click. Kept in sync by hand — the static page cannot import.
const PAGE_CSS = `
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --card: #171a21;
  --fg: #e7e9ee;
  --muted: #9aa3b2;
  --accent: #4c8dff;
  --accent-hover: #3b7af0;
  --border: #262b36;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  min-height: 100vh;
  display: flex;
  justify-content: center;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  line-height: 1.75;
  background: radial-gradient(1200px 600px at 50% -10%, #1b2130, var(--bg));
  color: var(--fg);
}
.card {
  width: 100%;
  max-width: 720px;
  height: fit-content;
  padding: 28px 32px 32px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.back { display: inline-block; margin-bottom: 18px; font-size: 13px; color: var(--muted); }
.back:hover { color: var(--fg); }
header { margin-bottom: 22px; }
h1 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.4; }
.meta, .summary { margin: 6px 0 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
article h2 { margin: 26px 0 10px; font-size: 17px; }
article h3 { margin: 20px 0 8px; font-size: 15px; }
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
  background: rgba(255, 255, 255, 0.08);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
article pre {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  overflow: auto;
}
article pre code { padding: 0; background: none; }
article table {
  display: block;
  overflow-x: auto;
  margin: 12px 0;
  border-collapse: collapse;
  font-size: 13px;
}
article th, article td { padding: 6px 10px; border: 1px solid var(--border); text-align: left; }
article th { background: rgba(255, 255, 255, 0.04); }
article hr { margin: 24px 0; border: 0; border-top: 1px solid var(--border); }
article img { max-width: 100%; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { padding: 14px 0; border-top: 1px solid var(--border); }
.list li:last-child { padding-bottom: 0; }
.list a { color: inherit; }
.list .v { font-weight: 600; }
.list a:hover .v, .list a:focus-visible .v { color: var(--accent); text-decoration: underline; }
.list .d { margin-left: 8px; color: var(--muted); font-size: 12px; }
.list .s { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; }
.empty { color: var(--muted); }
@media (max-width: 560px) {
  body { padding: 12px; }
  .card { padding: 20px 18px 24px; border-radius: 12px; }
}
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
    <main class="card">
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
