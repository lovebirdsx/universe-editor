/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the static download page's embedded update-notes logic: the data-source
 *  fallback chain (notes/index.json → release-notes.json → hidden), the latest.yml version
 *  ceiling, the 7-day window that must never drop the newest release, and the grouping that
 *  shows one entry per main note (patches merge under the note they belong to).
 *
 *  The page exposes `globalThis.__ueDownloadPage` and starts itself only when
 *  `__UE_DOWNLOAD_PAGE_NO_AUTORUN__` is unset, so these cases await the real render instead
 *  of counting macrotasks.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pageHtml = readFileSync(join(__dirname, '..', 'download-page', 'index.html'), 'utf8')
const pageScript = /<script>([\s\S]*?)<\/script>/.exec(pageHtml)?.[1]

if (!pageScript) throw new Error('download page script block not found')

class Element {
  children = []
  textContent = ''
  className = ''
  href = ''
  hidden = false

  classList = {
    add: (name) => {
      if (name === 'hidden') this.hidden = true
    },
    remove: (name) => {
      if (name === 'hidden') this.hidden = false
    },
  }

  constructor(tag = 'div') {
    this.tag = tag
  }

  appendChild(child) {
    this.children.push(child)
    return child
  }

  setAttribute(name, value) {
    this[name] = value
  }
}

// 页面里带 class="… hidden" 的元素开局就是隐藏的；假 document 必须复现这一点，
// 否则「没数据时不展示」的用例会永远看到可见。
const INITIALLY_HIDDEN = new Set(
  (pageHtml.match(/<(?:div|section|span|a|nav|main)[^>]*>/g) ?? [])
    .map((tag) => ({
      id: /id="([^"]+)"/.exec(tag)?.[1],
      cls: /class="([^"]*)"/.exec(tag)?.[1] ?? '',
    }))
    .filter((entry) => entry.id && /\bhidden\b/.test(entry.cls))
    .map((entry) => entry.id),
)

function createDocument() {
  const elements = new Map()
  return {
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new Element()
        element.hidden = INITIALLY_HIDDEN.has(id)
        elements.set(id, element)
      }
      return elements.get(id)
    },
    createElement(tag) {
      return new Element(tag)
    },
  }
}

function collectText(element) {
  return [element.textContent, ...element.children.map(collectText)].filter(Boolean).join('\n')
}

function collectLinks(element) {
  const own = element.tag === 'a' && element.href ? [element.href] : []
  return [...own, ...element.children.flatMap(collectLinks)]
}

const LATEST_YML = `version: 0.1.7
files:
  - url: Universe Editor-0.1.7-win-x64.exe
    size: 1048576
releaseDate: '2026-06-10T00:00:00.000Z'
`

/**
 * Run the page against a fake file set. `files` maps a fetched path to its body; anything
 * absent answers 404 — the same shape the static server gives for a file the deployment
 * never uploaded.
 */
async function renderDownloadPage(files) {
  const document = createDocument()
  const requested = []
  const sandbox = {
    document,
    __UE_DOWNLOAD_PAGE_NO_AUTORUN__: true,
    fetch: async (url) => {
      requested.push(url)
      if (!(url in files)) return { ok: false, status: 404 }
      const body = files[url]
      return { ok: true, json: async () => JSON.parse(body), text: async () => body }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(pageScript, sandbox)
  await sandbox.__ueDownloadPage.main()
  return {
    requested,
    notesText: collectText(document.getElementById('entries')),
    links: collectLinks(document.getElementById('entries')),
    notesHidden: document.getElementById('notes').hidden,
    moreHidden: document.getElementById('notes-more').hidden,
  }
}

const indexJson = (versions) => JSON.stringify({ schema: 1, versions })
const runtimeJson = (versions) => JSON.stringify(versions)

test('renders the 7-day window from notes/index.json with links to the version pages', async () => {
  const result = await renderDownloadPage({
    'latest.yml': LATEST_YML,
    'notes/index.json': indexJson([
      {
        version: '0.1.7',
        date: '2026-06-03',
        title: '启动更快',
        summary: '摘要 7',
        path: 'v0.1.7.html',
      },
      { version: '0.1.6', date: '2026-06-02', title: '', summary: '摘要 6', path: 'v0.1.6.html' },
      { version: '0.1.2', date: '2026-05-27', title: '', summary: '摘要 2', path: 'v0.1.2.html' },
    ]),
  })

  assert.equal(result.notesHidden, false)
  assert.equal(result.moreHidden, false)
  // 「全部版本介绍」是静态链接，指向编译产物里的历史索引页。
  assert.match(pageHtml, /<a id="all-versions" href="notes\/index\.html">/)
  assert.match(result.notesText, /v0\.1\.7/)
  assert.match(result.notesText, /启动更快/)
  assert.match(result.notesText, /摘要 7/)
  assert.match(result.notesText, /v0\.1\.6/)
  assert.doesNotMatch(result.notesText, /v0\.1\.2/)
  // Only the index is read when it exists — the runtime JSON is the fallback.
  assert.deepEqual(result.requested, ['latest.yml', 'notes/index.json'])
})

test('never advertises a version above latest.yml', async () => {
  const result = await renderDownloadPage({
    'latest.yml': LATEST_YML,
    'notes/index.json': indexJson([
      {
        version: '0.2.0',
        date: '2026-06-03',
        title: '未来',
        summary: '尚未发布',
        path: 'v0.2.0.html',
      },
      { version: '0.1.7', date: '2026-06-03', title: '', summary: '摘要 7', path: 'v0.1.7.html' },
    ]),
  })
  assert.doesNotMatch(result.notesText, /未来/)
  assert.doesNotMatch(result.notesText, /尚未发布/)
  assert.match(result.notesText, /摘要 7/)
})

test('keeps the newest release visible when its date falls outside the window', async () => {
  const result = await renderDownloadPage({
    'latest.yml': `version: 0.1.7
files:
  - url: Setup.exe
    size: 1024
`,
    'notes/index.json': indexJson([
      { version: '0.1.7', date: '2026-01-01', title: '', summary: '很久以前', path: 'v0.1.7.html' },
      { version: '0.1.6', date: '2026-06-02', title: '', summary: '摘要 6', path: 'v0.1.6.html' },
    ]),
  })
  assert.match(result.notesText, /很久以前/)
  assert.doesNotMatch(result.notesText, /摘要 6/)
})

test('groups a patch install under its main note and shows the newest applicable version once', async () => {
  const result = await renderDownloadPage({
    'latest.yml': `version: 0.1.7
files:
  - url: Setup.exe
    size: 1024
releaseDate: '2026-06-10T00:00:00.000Z'
`,
    'notes/index.json': indexJson([
      {
        version: '0.1.7',
        date: '2026-06-10',
        title: '启动更快',
        summary: '摘要 7',
        urgency: 'normal',
        notesVersion: '0.1.7',
        path: 'v0.1.7.html',
      },
      // 补丁：安装版本 0.1.6 归到主稿 0.1.5，自身没有标题/摘要与页面。
      {
        version: '0.1.6',
        date: '2026-06-09',
        urgency: 'normal',
        notesVersion: '0.1.5',
        path: 'v0.1.5.html',
      },
      {
        version: '0.1.5',
        date: '2026-06-02',
        title: '上一个版本',
        summary: '摘要 5',
        urgency: 'normal',
        notesVersion: '0.1.5',
        path: 'v0.1.5.html',
      },
    ]),
  })

  // 主稿 0.1.5 只出现一次，用主稿标题/摘要，展示组内最新安装版本 0.1.6，链接指向主稿页。
  assert.match(result.notesText, /上一个版本/)
  assert.match(result.notesText, /摘要 5/)
  assert.match(result.notesText, /v0\.1\.6/)
  assert.doesNotMatch(result.notesText, /v0\.1\.5/)
  assert.ok(result.links.includes('notes/v0.1.5.html'))
  assert.ok(!result.links.includes('notes/v0.1.6.html'))
  // 主稿 0.1.7 组仍是独立一篇。
  assert.match(result.notesText, /摘要 7/)
  assert.ok(result.links.includes('notes/v0.1.7.html'))
})

test('collapses several patches of one main note into a single entry', async () => {
  const result = await renderDownloadPage({
    'latest.yml': `version: 0.1.7
files:
  - url: Setup.exe
    size: 1024
releaseDate: '2026-06-10T00:00:00.000Z'
`,
    'notes/index.json': indexJson([
      {
        version: '0.1.7',
        date: '2026-06-09',
        urgency: 'normal',
        notesVersion: '0.1.4',
        path: 'v0.1.4.html',
      },
      {
        version: '0.1.6',
        date: '2026-06-08',
        urgency: 'normal',
        notesVersion: '0.1.4',
        path: 'v0.1.4.html',
      },
      {
        version: '0.1.4',
        date: '2026-06-01',
        title: '主稿标题',
        summary: '主稿摘要',
        urgency: 'normal',
        notesVersion: '0.1.4',
        path: 'v0.1.4.html',
      },
    ]),
  })

  assert.equal(result.notesText.match(/主稿标题/g)?.length, 1)
  assert.equal(result.notesText.match(/v0\.1\.7/g)?.length, 1)
  assert.equal(result.links.filter((href) => href === 'notes/v0.1.4.html').length, 1)
})

test('keeps the newest group visible when no index entry matches latest.yml and its date is stale', async () => {
  const result = await renderDownloadPage({
    'latest.yml': `version: 0.1.9
files:
  - url: Setup.exe
    size: 1024
releaseDate: '2026-06-10T00:00:00.000Z'
`,
    'notes/index.json': indexJson([
      // 最新一组（主稿 0.1.7 + 补丁 0.1.8）发布日期远早于窗口，仍必须展示。
      {
        version: '0.1.8',
        date: '2026-01-02',
        urgency: 'important',
        notesVersion: '0.1.7',
        path: 'v0.1.7.html',
      },
      {
        version: '0.1.7',
        date: '2026-01-01',
        title: '很久以前',
        summary: '摘要 7',
        urgency: 'normal',
        notesVersion: '0.1.7',
        path: 'v0.1.7.html',
      },
      {
        version: '0.1.6',
        date: '2026-06-05',
        title: '窗口内',
        summary: '摘要 6',
        urgency: 'normal',
        notesVersion: '0.1.6',
        path: 'v0.1.6.html',
      },
    ]),
  })

  // 最新归属不能被时间窗过滤掉，且展示组内最新的安装版本 0.1.8。
  assert.match(result.notesText, /很久以前/)
  assert.match(result.notesText, /v0\.1\.8/)
  assert.match(result.notesText, /窗口内/)
  assert.ok(result.links.includes('notes/v0.1.7.html'))
})

test('normalizeIndex keeps notesVersion (defaulting to version) and urgency, including normal', async () => {
  const document = createDocument()
  const sandbox = {
    document,
    __UE_DOWNLOAD_PAGE_NO_AUTORUN__: true,
    fetch: async () => ({ ok: false }),
  }
  vm.createContext(sandbox)
  vm.runInContext(pageScript, sandbox)
  const normalized = sandbox.__ueDownloadPage.normalizeIndex({
    versions: [
      { version: '0.1.7', urgency: 'normal', notesVersion: '0.1.5', path: 'v0.1.5.html' },
      { version: '0.1.6', urgency: 'important', path: 'v0.1.6.html' },
    ],
  })
  assert.deepEqual(normalized[0].notesVersion, '0.1.5')
  assert.equal(normalized[0].urgency, 'normal')
  // 缺 notesVersion 时回落为自身版本；缺 urgency 时视为 normal。
  assert.equal(normalized[1].notesVersion, '0.1.6')
  assert.equal(normalized[1].urgency, 'important')
})

test('falls back to release-notes.json (metadata only, no page links)', async () => {
  const result = await renderDownloadPage({
    'latest.yml': LATEST_YML,
    'release-notes.json': runtimeJson([
      { version: '0.1.7', date: '2026-06-03', title: '标题', summary: '摘要 7', body: '## x' },
      { version: '0.1.6', date: '2026-06-02', title: '', summary: '摘要 6', body: '## y' },
    ]),
  })
  assert.equal(result.notesHidden, false)
  assert.equal(result.moreHidden, true)
  assert.match(result.notesText, /摘要 7/)
  assert.match(result.notesText, /v0\.1\.6/)
  assert.deepEqual(result.requested, ['latest.yml', 'notes/index.json', 'release-notes.json'])
})

test('hides the notes section entirely when neither source is deployed', async () => {
  const result = await renderDownloadPage({ 'latest.yml': LATEST_YML })
  assert.equal(result.notesHidden, true)
  assert.equal(result.moreHidden, true)
  assert.equal(result.notesText, '')
})

test('a legacy notes file without metadata degrades to no notes, not a broken page', async () => {
  const result = await renderDownloadPage({
    'latest.yml': LATEST_YML,
    // 旧形态（groups/items）：没有 title/summary/date，页面不应渲染出空壳。
    'notes/index.json': JSON.stringify({ versions: [] }),
    'release-notes.json': JSON.stringify([
      { version: '0.1.7', groups: [{ title: 'x', items: ['y'] }] },
    ]),
  })
  assert.equal(result.notesHidden, true)
})

test('the page never injects fetched content as HTML and loads no external resources', () => {
  // No innerHTML anywhere the fetched data could reach it.
  assert.doesNotMatch(pageScript, /innerHTML/)
  assert.doesNotMatch(pageScript, /insertAdjacentHTML/)
  assert.doesNotMatch(pageScript, /document\.write/)
  // Zero external resources: no <script src>, no <link>, and no remote URLs in the page.
  assert.doesNotMatch(pageHtml, /<script[^>]+src=/i)
  assert.doesNotMatch(pageHtml, /<link[^>]+href=["']https?:/i)
  assert.doesNotMatch(pageHtml, /https?:\/\/[^\s"']+\.(?:js|css)/i)
})

test('the page exposes its helpers and does not auto-run under the test flag', async () => {
  const document = createDocument()
  const sandbox = {
    document,
    __UE_DOWNLOAD_PAGE_NO_AUTORUN__: true,
    fetch: async () => ({ ok: false }),
  }
  vm.createContext(sandbox)
  vm.runInContext(pageScript, sandbox)
  assert.equal(typeof sandbox.__ueDownloadPage.main, 'function')
  assert.equal(sandbox.__ueDownloadPage.compareVersions('0.10.0', '0.9.0'), 1)
  assert.equal(sandbox.__ueDownloadPage.formatSize(1048576), '1.0 MB')
  // Rendering only happens when main() is called.
  assert.equal(document.getElementById('entries').children.length, 0)
})
