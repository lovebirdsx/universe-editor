/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  check-doc-links.mjs — verify internal relative links in docs/user/**\/*.md.
 *
 *  For each .md file, extract all [text](href) relative links and check that
 *  the resolved target file exists on disk. Anchor fragments (#section) are
 *  accepted without further validation (phase-2 work). Exits with code 1 if
 *  any broken links are found.
 *
 *  Usage:
 *    node scripts/check-doc-links.mjs
 *    pnpm docs:check
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../')
const DOCS_ROOT = join(REPO_ROOT, 'docs', 'user')

/** Recursively collect all .md files under a directory. */
function collectMd(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectMd(full))
    } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
      files.push(full)
    }
  }
  return files
}

/** Extract all relative link hrefs from markdown source (strips fragments). */
function extractRelativeLinks(source) {
  // Match [label](href) — not ![]() images (those don't need to be checked here),
  // skip URLs with a scheme (http:, file:, universe:, etc.).
  const linkRe = /\[(?:[^\]]*)\]\(([^)]+)\)/g
  const hrefs = []
  let m
  while ((m = linkRe.exec(source)) !== null) {
    const raw = m[1]?.trim() ?? ''
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue // absolute URL — skip
    if (raw.startsWith('#')) continue // same-page anchor — skip
    // Strip fragment
    const hashIdx = raw.indexOf('#')
    const path = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
    if (path) hrefs.push(path)
  }
  return hrefs
}

function run() {
  if (!existsSync(DOCS_ROOT)) {
    console.log('docs/user/ directory not found — nothing to check.')
    process.exit(0)
  }

  const files = collectMd(DOCS_ROOT)
  const broken = []

  for (const file of files) {
    const source = readFileSync(file, 'utf-8')
    const hrefs = extractRelativeLinks(source)
    for (const href of hrefs) {
      const target = resolve(dirname(file), href)
      // Accept either the path as-is or with .md appended (in case href omits extension).
      if (!existsSync(target) && !existsSync(target + '.md')) {
        broken.push({ file: file.replace(REPO_ROOT + '/', ''), href, target: target.replace(REPO_ROOT + '/', '') })
      }
    }
  }

  if (broken.length === 0) {
    console.log(`doc-links: checked ${files.length} file(s), no broken links.`)
    process.exit(0)
  }

  console.error(`doc-links: found ${broken.length} broken link(s):\n`)
  for (const { file, href, target } of broken) {
    console.error(`  ${file}\n    → [${href}] → ${target} (not found)\n`)
  }
  process.exit(1)
}

run()
