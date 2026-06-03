/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the static download page's embedded release-notes filtering logic.
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

  classList = {
    add: () => {},
    remove: () => {},
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

function createDocument() {
  const elements = new Map()
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element())
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

async function renderDownloadPage({ latestYml, notes }) {
  const document = createDocument()
  const sandbox = {
    document,
    fetch: async (url) => {
      if (url === 'latest.yml') return { ok: true, text: async () => latestYml }
      if (url === 'release-notes.json') return { ok: true, json: async () => notes }
      throw new Error(`unexpected fetch: ${url}`)
    },
  }

  new Function(pageScript)
  vm.createContext(sandbox)
  vm.runInContext(pageScript, sandbox)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return collectText(document.getElementById('groups'))
}

test('download page renders all release notes within the latest version week', async () => {
  const text = await renderDownloadPage({
    latestYml: `version: 0.1.7
files:
  - url: Universe Editor-0.1.7-win-x64.exe
    size: 1048576
releaseDate: '2026-06-10T00:00:00.000Z'
`,
    notes: [
      { version: '0.1.7', date: '2026-06-03', groups: [{ title: '新功能', items: ['C'] }] },
      { version: '0.1.6', date: '2026-06-02', groups: [{ title: 'Bug 修复', items: ['B'] }] },
      { version: '0.1.2', date: '2026-05-27', groups: [{ title: '旧版本', items: ['A'] }] },
    ],
  })

  assert.match(text, /v0\.1\.7/)
  assert.match(text, /C/)
  assert.match(text, /v0\.1\.6/)
  assert.match(text, /B/)
  assert.doesNotMatch(text, /v0\.1\.2/)
  assert.doesNotMatch(text, /A/)
})

test('download page falls back to the latest version when note dates are unavailable', async () => {
  const text = await renderDownloadPage({
    latestYml: `version: 0.1.7
files:
  - url: Universe Editor-0.1.7-win-x64.exe
    size: 1048576
`,
    notes: [
      { version: '0.1.7', groups: [{ title: '新功能', items: ['C'] }] },
      { version: '0.1.6', groups: [{ title: 'Bug 修复', items: ['B'] }] },
    ],
  })

  assert.match(text, /v0\.1\.7/)
  assert.match(text, /C/)
  assert.doesNotMatch(text, /v0\.1\.6/)
  assert.doesNotMatch(text, /B/)
})
