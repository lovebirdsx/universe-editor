/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for DocsMainService — reads docs/user/<locale>/**\/*.md off disk, keys
 *  them by locale-relative path (no .md), and degrades to an empty map when a
 *  locale directory is absent.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocsMainService } from '../docsMainService.js'

describe('DocsMainService', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ue-docs-svc-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(rel: string, content: string): void {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }

  it('reads nested .md files keyed by locale-relative path without .md', async () => {
    write('zh-CN/index.md', '# 首页')
    write('zh-CN/getting-started/interface-tour.md', '# 界面导览')

    const docs = await new DocsMainService(() => root).getDocs()

    expect(docs['zh-CN']?.['index']).toBe('# 首页')
    expect(docs['zh-CN']?.['getting-started/interface-tour']).toBe('# 界面导览')
  })

  it('ignores non-markdown files', async () => {
    write('zh-CN/index.md', '# 首页')
    write('zh-CN/assets/screenshot.png', 'binary')

    const docs = await new DocsMainService(() => root).getDocs()

    expect(Object.keys(docs['zh-CN'] ?? {})).toEqual(['index'])
  })

  it('degrades to an empty map for a missing locale directory', async () => {
    write('zh-CN/index.md', '# 首页')

    const docs = await new DocsMainService(() => root).getDocs()

    expect(docs['zh-CN']?.['index']).toBe('# 首页')
    expect(docs['en-US']).toEqual({})
  })

  it('caches the result across calls', async () => {
    write('zh-CN/index.md', '# 首页')
    const svc = new DocsMainService(() => root)

    const first = await svc.getDocs()
    write('zh-CN/late.md', '# 迟到')
    const second = await svc.getDocs()

    expect(second).toBe(first)
    expect(second['zh-CN']?.['late']).toBeUndefined()
  })
})
